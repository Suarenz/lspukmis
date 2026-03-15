import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import jwtService from '@/lib/services/jwt-service';
import prisma from '@/lib/prisma';
import { hasAnyRole, type UserRole } from '@/lib/utils/rbac';

export async function requireAuth(request: NextRequest, roles?: string[]): Promise<{ user: any } | NextResponse> {
  // Extract the token from the Authorization header or cookies
  const authHeader = request.headers.get('authorization');
  let token = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    // Try to get token from cookies
    const cookies = request.cookies;
    token = cookies.get('access_token')?.value;
  }

  if (!token) {
    // For API routes, return a 401 response instead of redirecting
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    // For regular routes, redirect to login
    const response = NextResponse.redirect(new URL('/login', request.url));
    return response;
  }

  // Verify the JWT token
  const decoded = await jwtService.verifyToken(token);
  if (!decoded) {
    console.error('Token verification failed:', token ? token.substring(0, 20) + '...' : 'null');
    // Token is invalid, return appropriate response based on request type
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    } else {
      // For regular routes, redirect to login
      const response = NextResponse.redirect(new URL('/', request.url));
      return response;
    }
 }

  // Check if decoded.userId is valid
  if (!decoded.userId) {
    console.error('Token does not contain userId:', decoded);
    // Token doesn't contain a valid userId, return error
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Invalid token: missing user ID' }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL('/login', request.url));
    return response;
 }

  // Get user profile from database using the user ID from the token
  const user = await prisma.user.findUnique({
    where: {
      id: decoded.userId,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      unitId: true,
    }
  });

  if (!user) {
    console.error('User not found with ID from token:', decoded.userId);
    // User doesn't exist in the database, redirect to login
    const response = NextResponse.redirect(new URL('/login', request.url));
    return response;
 }

  // Check if user has required roles
  if (roles && roles.length > 0 && !hasAnyRole(user.role as UserRole, roles as UserRole[])) {
    // User doesn't have required role, return error for API routes
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'User does not have required role to perform this action' }, { status: 403 });
    }
    // For regular routes, redirect to unauthorized page
    const response = NextResponse.redirect(new URL('/unauthorized', request.url));
    return response;
  }

  return { user };
}