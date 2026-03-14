/**
 * Role-Based Access Control (RBAC) utilities for LSPU KMIS
 * Defines role hierarchies and permission checks
 */

export type UserRole = 'ADMIN' | 'FACULTY' | 'PERSONNEL' | 'STUDENT' | 'EXTERNAL';

// Define role hierarchy - ADMIN has highest privileges, followed by FACULTY/PERSONNEL, STUDENT, then EXTERNAL
const ROLE_HIERARCHY: Record<UserRole, number> = {
  'ADMIN': 4,
  'FACULTY': 3,
  'PERSONNEL': 3,
  'STUDENT': 2,
  'EXTERNAL': 1
};

/**
 * Check if a user has a specific role
 */
export function hasRole(userRole: UserRole, requiredRole: UserRole): boolean {
  return userRole === requiredRole;
}

/**
 * Check if a user has any of the specified roles
 */
export function hasAnyRole(userRole: UserRole, requiredRoles: UserRole[]): boolean {
  return requiredRoles.includes(userRole);
}

/**
 * Check if a user's role has higher or equal hierarchy than required role
 */
export function hasRoleHierarchy(userRole: UserRole, requiredRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Check if user has admin privileges
 */
export function isAdmin(userRole: UserRole): boolean {
  return userRole === 'ADMIN';
}

/**
 * Check if user has faculty privileges
 */
export function isFaculty(userRole: UserRole): boolean {
  return userRole === 'FACULTY' || userRole === 'PERSONNEL' || userRole === 'ADMIN';
}

/**
 * Check if user has student privileges
 */
export function isStudent(userRole: UserRole): boolean {
  return userRole === 'STUDENT' || userRole === 'FACULTY' || userRole === 'PERSONNEL' || userRole === 'ADMIN';
}

/**
 * Check if user has external privileges
 */
export function isExternal(userRole: UserRole): boolean {
  return userRole === 'EXTERNAL' || userRole === 'STUDENT' || userRole === 'FACULTY' || userRole === 'PERSONNEL' || userRole === 'ADMIN';
}

/**
 * Get allowed actions based on user role
 */
export function getAllowedActions(userRole: UserRole): string[] {
  switch (userRole) {
    case 'ADMIN':
      return [
        'CREATE_DOCUMENT',
        'READ_DOCUMENT',
        'UPDATE_DOCUMENT',
        'DELETE_DOCUMENT',
        'CREATE_USER',
        'READ_USER',
        'UPDATE_USER',
        'DELETE_USER',
        'CREATE_UNIT',
        'READ_UNIT',
        'UPDATE_UNIT',
        'DELETE_UNIT',
        'MANAGE_PERMISSIONS',
        'VIEW_ANALYTICS'
      ];
    case 'FACULTY':
    case 'PERSONNEL':
      return [
        'CREATE_DOCUMENT',
        'READ_DOCUMENT',
        'UPDATE_DOCUMENT',
        'READ_USER',
        'READ_UNIT',
        'VIEW_ANALYTICS'
      ];
    case 'STUDENT':
      return [
        'READ_DOCUMENT',
        'READ_USER',
        'READ_UNIT'
      ];
    case 'EXTERNAL':
      return [
        'READ_DOCUMENT'
      ];
    default:
      return [];
  }
}

/**
 * Check if a user has permission to perform an action
 */
export function hasPermission(userRole: UserRole, action: string): boolean {
  const allowedActions = getAllowedActions(userRole);
  return allowedActions.includes(action);
}

/**
 * Get all roles that can perform a specific action
 */
export function getRolesForAction(action: string): UserRole[] {
  const roles: UserRole[] = [];
  (Object.keys(ROLE_HIERARCHY) as UserRole[]).forEach(role => {
    if (hasPermission(role, action)) {
      roles.push(role);
    }
  });
  return roles;
}