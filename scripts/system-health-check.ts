#!/usr/bin/env tsx
/**
 * System Health Check Script
 * Validates all critical components of LSPU KMIS
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(check: string) {
  log(`✓ ${check}`, colors.green);
}

function error(check: string, details?: string) {
  log(`✗ ${check}`, colors.red);
  if (details) log(`  ${details}`, colors.yellow);
}

function warning(check: string, details?: string) {
  log(`⚠ ${check}`, colors.yellow);
  if (details) log(`  ${details}`, colors.yellow);
}

function section(title: string) {
  log(`\n${title}`, colors.cyan);
  log('='.repeat(title.length), colors.cyan);
}

// Health check results
let checksRun = 0;
let checksPassed = 0;
let checksFailed = 0;
let checksWarning = 0;

async function checkEnvironmentVariables() {
  section('1. Environment Variables');
  
  const requiredVars = [
    'DATABASE_URL',
    'JWT_SECRET',
    'COLIVARA_API_KEY',
    'COLIVARA_API_ENDPOINT',
    'AZURE_STORAGE_CONNECTION_STRING',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
  ];

  const optionalVars = [
    'OPENAI_API_KEY',
    'GOOGLE_AI_API_KEY',
    'QWEN_API_KEY',
  ];

  for (const varName of requiredVars) {
    checksRun++;
    if (process.env[varName]) {
      success(`${varName} is set`);
      checksPassed++;
    } else {
      error(`${varName} is missing`, 'This is required for the system to function');
      checksFailed++;
    }
  }

  for (const varName of optionalVars) {
    checksRun++;
    if (process.env[varName]) {
      success(`${varName} is set`);
      checksPassed++;
    } else {
      warning(`${varName} is not set`, 'AI generation features may be limited');
      checksWarning++;
    }
  }
}

async function checkDatabaseConnection() {
  section('2. Database Connection');
  
  try {
    checksRun++;
    await prisma.$connect();
    success('Database connection established');
    checksPassed++;

    // Test a simple query
    checksRun++;
    const userCount = await prisma.user.count();
    success(`Database query successful (${userCount} users found)`);
    checksPassed++;

  } catch (err) {
    checksFailed += 2;
    error('Database connection failed', err instanceof Error ? err.message : String(err));
  }
}

async function checkDatabaseSchema() {
  section('3. Database Schema');
  
  try {
    // Check critical tables exist
    const criticalModels = [
      { name: 'User', query: () => prisma.user.findFirst() },
      { name: 'Document', query: () => prisma.document.findFirst() },
      { name: 'Unit', query: () => prisma.unit.findFirst() },
      { name: 'Activity', query: () => prisma.activity.findFirst() },
      { name: 'DocumentPermission', query: () => prisma.documentPermission.findFirst() },
    ];
    
    // Check QPRO table separately (might not exist in older schemas)
    try {
      checksRun++;
      if (prisma.qPROAnalysis) {
        await prisma.qPROAnalysis.findFirst();
        success('QproAnalysis table exists and accessible');
        checksPassed++;
      } else {
        warning('QproAnalysis table not found', 'QPRO features may not be available');
        checksWarning++;
      }
    } catch (err) {
      checksWarning++;
      warning('QproAnalysis table check skipped', 'Table may not exist in schema');
    }

    for (const model of criticalModels) {
      try {
        checksRun++;
        await model.query();
        success(`${model.name} table exists and accessible`);
        checksPassed++;
      } catch (err) {
        checksFailed++;
        error(`${model.name} table check failed`, err instanceof Error ? err.message : String(err));
      }
    }

  } catch (err) {
    error('Schema validation failed', err instanceof Error ? err.message : String(err));
  }
}

async function checkExternalServices() {
  section('4. External Services');

  // Check Colivara
  checksRun++;
  if (process.env.COLIVARA_API_KEY && process.env.COLIVARA_API_ENDPOINT) {
    try {
      const response = await fetch(`${process.env.COLIVARA_API_ENDPOINT}/health`, {
        headers: { 'Authorization': `Bearer ${process.env.COLIVARA_API_KEY}` }
      });
      if (response.ok) {
        success('Colivara API is reachable');
        checksPassed++;
      } else {
        warning('Colivara API returned non-OK status', `Status: ${response.status}`);
        checksWarning++;
      }
    } catch (err) {
      warning('Colivara API check failed', err instanceof Error ? err.message : String(err));
      checksWarning++;
    }
  } else {
    warning('Colivara API not configured');
    checksWarning++;
  }

  // Check Redis (Upstash)
  checksRun++;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
        headers: { 'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
      });
      if (response.ok) {
        success('Redis (Upstash) is reachable');
        checksPassed++;
      } else {
        warning('Redis returned non-OK status', `Status: ${response.status}`);
        checksWarning++;
      }
    } catch (err) {
      warning('Redis check failed', err instanceof Error ? err.message : String(err));
      checksWarning++;
    }
  } else {
    warning('Redis not configured', 'Caching features may not work');
    checksWarning++;
  }

  // Check Azure Storage
  checksRun++;
  if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    success('Azure Storage connection string is configured');
    checksPassed++;
  } else {
    error('Azure Storage not configured', 'File uploads will fail');
    checksFailed++;
  }
}

async function checkAuthSystem() {
  section('5. Authentication System');

  checksRun++;
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    success('JWT secret is configured and secure');
    checksPassed++;
  } else {
    error('JWT secret is weak or missing', 'Should be at least 32 characters');
    checksFailed++;
  }

  // Check if there's at least one admin user
  try {
    checksRun++;
    const adminCount = await prisma.user.count({
      where: { role: 'ADMIN' }
    });
    if (adminCount > 0) {
      success(`Admin users exist (${adminCount} found)`);
      checksPassed++;
    } else {
      warning('No admin users found', 'You should create an admin user');
      checksWarning++;
    }
  } catch (err) {
    checksFailed++;
    error('Could not check admin users', err instanceof Error ? err.message : String(err));
  }
}

async function checkCriticalData() {
  section('6. Critical Data');

  try {
    // Check for units
    checksRun++;
    const unitCount = await prisma.unit.count();
    if (unitCount > 0) {
      success(`Units exist (${unitCount} found)`);
      checksPassed++;
    } else {
      warning('No units found', 'Consider running init-units.sql');
      checksWarning++;
    }

    // Check for documents
    checksRun++;
    const docCount = await prisma.document.count();
    if (docCount > 0) {
      success(`Documents exist (${docCount} found)`);
      checksPassed++;
    } else {
      warning('No documents found', 'System is empty - upload some documents');
      checksWarning++;
    }

    // Check for active documents
    checksRun++;
    const activeDocCount = await prisma.document.count({
      where: { status: 'ACTIVE' }
    });
    if (activeDocCount > 0) {
      success(`Active documents exist (${activeDocCount} found)`);
      checksPassed++;
    } else {
      warning('No active documents found');
      checksWarning++;
    }

  } catch (err) {
    error('Critical data check failed', err instanceof Error ? err.message : String(err));
  }
}

async function checkSearchIndexing() {
  section('7. Search & Indexing');

  try {
    // Check for indexed documents
    checksRun++;
    const indexedDocs = await prisma.document.count({
      where: { 
        status: 'ACTIVE',
        colivaraDocumentId: { not: null }
      }
    });
    const totalDocs = await prisma.document.count({ where: { status: 'ACTIVE' } });
    
    if (indexedDocs > 0) {
      success(`Documents indexed in Colivara (${indexedDocs}/${totalDocs})`);
      checksPassed++;
    } else if (totalDocs > 0) {
      warning('No documents indexed in Colivara', 'Semantic search may not work');
      checksWarning++;
    } else {
      warning('No documents to index');
      checksWarning++;
    }

  } catch (err) {
    error('Indexing check failed', err instanceof Error ? err.message : String(err));
  }
}

async function runAllChecks() {
  log('\n╔══════════════════════════════════════════════╗', colors.blue);
  log('║   LSPU KMIS System Health Check              ║', colors.blue);
  log('╚══════════════════════════════════════════════╝', colors.blue);

  await checkEnvironmentVariables();
  await checkDatabaseConnection();
  await checkDatabaseSchema();
  await checkExternalServices();
  await checkAuthSystem();
  await checkCriticalData();
  await checkSearchIndexing();

  // Summary
  section('Summary');
  log(`Total checks: ${checksRun}`);
  log(`✓ Passed: ${checksPassed}`, colors.green);
  log(`✗ Failed: ${checksFailed}`, colors.red);
  log(`⚠ Warnings: ${checksWarning}`, colors.yellow);

  const successRate = ((checksPassed / checksRun) * 100).toFixed(1);
  
  if (checksFailed === 0) {
    log(`\n🎉 System is ${successRate}% operational!`, colors.green);
  } else if (checksFailed <= 2) {
    log(`\n⚠️  System is ${successRate}% operational with minor issues`, colors.yellow);
  } else {
    log(`\n❌ System has critical issues (${successRate}% operational)`, colors.red);
  }

  await prisma.$disconnect();
  process.exit(checksFailed > 0 ? 1 : 0);
}

// Run the health check
runAllChecks().catch((err) => {
  console.error('Health check crashed:', err);
  process.exit(1);
});
