import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import passwordService from '@/lib/services/password-service';
import jwtService from '@/lib/services/jwt-service';

interface SignupRequestBody {
  email: string;
  password: string;
  name: string;
  idNumber: string;
  unitId?: string;
  role?: 'ADMIN' | 'FACULTY' | 'STUDENT' | 'EXTERNAL' | 'PERSONNEL';
  department?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: SignupRequestBody = await request.json();
    const { email, password, name, idNumber, unitId, role = 'STUDENT', department } = body;

    // Validate input
    if (!email || !password || !name || !idNumber) {
      return NextResponse.json(
        { error: 'Email, password, name, and ID Number are required' },
        { status: 400 }
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email },
          { idNumber: idNumber }
        ]
      },
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return NextResponse.json(
          { error: 'User with this email already exists' },
          { status: 409 }
        );
      } else {
        return NextResponse.json(
          { error: 'User with this ID Number already exists' },
          { status: 409 }
        );
      }
    }

    // Hash the password
    const hashedPassword = await passwordService.hashPassword(password);

    // Create new user in the database
    const newUser = await prisma.user.create({
      data: {
        email: email,
        name: name,
        idNumber: idNumber,
        unitId: unitId,
        role: role,
        password: hashedPassword,
      },
    });

    // Generate JWT token for the new user
    const token = await jwtService.generateToken({
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    // Return user data and token
    return NextResponse.json({
      success: true,
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
        unitId: newUser.unitId,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred during signup' },
      { status: 500 }
    );
  }
}