// lib/api/base-api.ts
import type { ForumPost } from '../types';

class BaseAPI {
  protected baseUrl: string;
  protected headers: HeadersInit;

  constructor() {
    // In the browser, use the current origin so it works on any domain (dev or prod).
    // On the server (SSR), fall back to NEXT_PUBLIC_API_BASE_URL or localhost for dev.
    const defaultUrl = typeof window !== 'undefined'
      ? `${window.location.origin}/api`
      : (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000/api');

    this.baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || defaultUrl;
    this.headers = {
      'Content-Type': 'application/json',
    };
  }

  protected async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
   // Check if fetch is available (it's not available during SSR)
   if (typeof fetch === 'undefined') {
     throw new Error('Fetch API is not available during server-side rendering');
   }

   // Import AuthService dynamically to avoid SSR issues
   const { default: AuthService } = await import('@/lib/services/auth-service');
   const token = await AuthService.getAccessToken();

   const url = `${this.baseUrl}${endpoint}`;
   
   const config: RequestInit = {
     headers: {
       ...this.headers,
       ...options.headers,
       // Add authorization header if token exists
       ...(token && { 'Authorization': `Bearer ${token}` }),
     },
     ...options,
   };

   const response = await fetch(url, config);
   
   if (!response.ok) {
     throw new Error(`HTTP error! status: ${response.status}`);
   }
   
   return response.json() as Promise<T>;
 }

}

export default BaseAPI;