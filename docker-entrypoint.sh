#!/bin/sh
set -e

echo "🚀 Starting LSPU KMIS Docker Entrypoint..."

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  # Use node to check database connection
  if node -e "
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    prisma.\$connect()
      .then(() => { prisma.\$disconnect(); process.exit(0); })
      .catch(() => { process.exit(1); });
  " 2>/dev/null; then
    echo "✅ PostgreSQL is ready!"
    break
  fi
  
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "   Attempt $RETRY_COUNT/$MAX_RETRIES - PostgreSQL not ready yet, waiting..."
  sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "❌ Failed to connect to PostgreSQL after $MAX_RETRIES attempts"
  exit 1
fi

# Run Prisma migrations/push to ensure schema is up to date
echo "📦 Running Prisma database push..."
npx prisma@6.19.0 db push --accept-data-loss 2>&1 || {
  echo "⚠️  First attempt failed, regenerating Prisma client..."
  npx prisma@6.19.0 generate 2>&1
  npx prisma@6.19.0 db push --accept-data-loss 2>&1
}

# Check and create default users if needed
echo "👥 Checking for existing users..."
node -e "
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seedUsers() {
  const count = await prisma.user.count();
  console.log('Current user count: ' + count);
  
  if (count === 0) {
    console.log('Creating default users...');
    
    const users = [
      { email: 'admin@lspu.edu.ph', name: 'Admin User', role: 'ADMIN', password: 'admin123' },
      { email: 'faculty@lspu.edu.ph', name: 'Faculty User', role: 'FACULTY', password: 'faculty123' },
      { email: 'student@lspu.edu.ph', name: 'Student User', role: 'STUDENT', password: 'student123' },
      { email: 'external@partner.com', name: 'External Collaborator', role: 'EXTERNAL', password: 'external123' }
    ];
    
    for (const user of users) {
      const hashedPassword = await bcrypt.hash(user.password, 10);
      await prisma.user.create({
        data: {
          email: user.email,
          name: user.name,
          role: user.role,
          password: hashedPassword
        }
      });
      console.log('Created user: ' + user.email + ' (' + user.role + ')');
    }
    console.log('✅ Default users created successfully');
  } else {
    console.log('✅ Users already exist, skipping seed');
  }
  await prisma.\$disconnect();
}

seedUsers().catch(err => {
  console.error('Error seeding users:', err);
  process.exit(1);
});
" 2>&1

# Check and create default units if needed
echo "🏢 Checking for existing units..."
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedUnits() {
  const count = await prisma.unit.count();
  console.log('Current unit count: ' + count);
  
  if (count === 0) {
    console.log('Creating default units...');
    
    const units = [
      { code: 'CAS', name: 'College of Arts and Sciences' },
      { code: 'CBAA', name: 'College of Business Administration and Accountancy' },
      { code: 'CCS', name: 'College of Computer Studies' },
      { code: 'CCJE', name: 'College of Criminal Justice Education' },
      { code: 'COE', name: 'College of Engineering' },
      { code: 'CIT', name: 'College of Industrial Technology' },
      { code: 'CIHTM', name: 'College of International Hospitality and Tourism Management' },
      { code: 'CTE', name: 'College of Teacher Education' },
      { code: 'CONAH', name: 'College of Nursing and Allied Health' },
      { code: 'RDS', name: 'Research and Development Services' }
    ];
    
    for (const unit of units) {
      await prisma.unit.create({ data: unit });
      console.log('Created unit: ' + unit.name);
    }
    console.log('✅ Default units created successfully');
  } else {
    console.log('✅ Units already exist, skipping seed');
  }
  await prisma.\$disconnect();
}

seedUnits().catch(err => {
  console.error('Error seeding units:', err);
  process.exit(1);
});
" 2>&1

echo ""
echo "=========================================="
echo "🎉 LSPU KMIS is starting!"
echo "=========================================="
echo "   App URL: http://localhost:${PORT:-3000}"
echo "   External URL: ${NEXT_PUBLIC_API_URL:-http://localhost:4007}"
echo "   Database: PostgreSQL connected"
echo "=========================================="
echo ""
echo "Default login credentials:"
echo "   Admin: admin@lspu.edu.ph / admin123"
echo "   Faculty: faculty@lspu.edu.ph / faculty123"
echo "   Student: student@lspu.edu.ph / student123"
echo "=========================================="
echo ""

# Start the application
# If arguments are provided, execute them (default behavior for Docker)
# Otherwise, check NODE_ENV and fall back to standard execution
if [ "$#" -gt 0 ]; then
  echo "🏃 Running custom command: $@"
  exec "$@"
elif [ "$NODE_ENV" = "development" ]; then
  echo "⚒️ Starting in DEVELOPMENT mode with hot reloading..."
  # Ensure prisma is ready in dev
  npx prisma generate
  exec npm run dev
else
  echo "🚀 Starting in PRODUCTION mode..."
  # In production standalone build, node server.js is expected
  if [ -f "server.js" ]; then
    exec node server.js
  else
    echo "⚠️ server.js not found, falling back to npm start"
    exec npm start
  fi
fi
