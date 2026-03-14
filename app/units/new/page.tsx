'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Navbar } from '@/components/navbar';
import { UnitForm } from '@/components/unit-form';
import { Unit } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, ChevronLeft, ChevronRight } from 'lucide-react';
import { ClientOnly } from '@/components/client-only-wrapper';
import Image from 'next/image';
import AuthService from '@/lib/services/auth-service';
import { UnitSidebar } from '@/components/unit-sidebar';

export default function NewUnitPage() {
  const router = useRouter();
 const { user, isAuthenticated, isLoading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [units, setUnits] = useState<Unit[]>([]);

  // Fetch units for sidebar
  useEffect(() => {
    const fetchUnits = async () => {
      try {
        // First, verify that we have a valid authentication state
        if (!isAuthenticated || !user) {
          // If not authenticated, redirect to login
          router.push('/');
          return;
        }
        
        // Then try to get the access token
        const token = await AuthService.getAccessToken();
        if (!token) {
          // If no token is available despite being authenticated, log out the user
          await AuthService.logout();
          router.push('/');
          return;
        }
        
        const response = await fetch(`/api/units`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to fetch units: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        setUnits(data.units || []);
      } catch (err) {
        console.error('Error fetching units:', err);
        setUnits([]);
        // If there's an authentication error, redirect to login
        if (err instanceof Error && err.message.includes('No authentication token found')) {
          router.push('/');
        }
      }
    };
    
    if (isAuthenticated && user) {
      fetchUnits();
    }
  }, [isAuthenticated, user, router]);

  // Check if user is admin
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/');
    } else if (!isLoading && isAuthenticated && user && user.role !== 'ADMIN') {
      router.push('/repository'); // Redirect non-admins
    }
 }, [isAuthenticated, isLoading, user, router]);

  // Handle form submission
 const handleFormSubmit = (unit: Unit) => {
    // Navigate back to repository after successful creation
    router.push('/repository');
    router.refresh(); // Refresh to show the new unit in the sidebar
 };

  // Handle when a new unit is created
  const handleUnitCreated = (unit: Unit) => {
    // Optionally navigate to the newly created unit page
    setTimeout(() => {
      router.push(`/units/${unit.id}`);
      router.refresh();
    }, 1500); // Wait a bit for the toast to show before navigating
  };

  // Handle form cancellation
  const handleCancel = () => {
    router.push('/repository');
  };

  // Show loading state while authentication is being resolved
  if (isLoading || (!isAuthenticated && !user)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  // Don't render if user is null but authentication is loaded
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Loading user data...</p>
        </div>
      </div>
    );
  }

  // Check if user is admin
  if (user.role !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Building2 className="w-12 h-12 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-muted-foreground mb-4">
            Only administrators can create new units. Contact your system administrator for access.
          </p>
          <Button onClick={() => router.push('/repository')}>
            Go to Repository
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ClientOnly>
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="flex">
          {/* Unit Sidebar */}
          {sidebarOpen && (
            <div className="w-64 border-r bg-muted/10 hidden lg:block">
              <UnitSidebar
                units={units}
                currentUnit={null}
                onUnitSelect={(unitId) => {
                  if (unitId) {
                    router.push(`/units/${unitId}`);
                  } else {
                    router.push('/repository');
                  }
                }}
                userRole={user?.role || ''}
                userUnit={user?.unitId || null}
              />
            </div>
          )}
          
          {/* Main Content */}
          <main className="flex-1 lg:ml-0">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              {/* Header */}
              <div className="mb-8">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="lg:hidden"
                      onClick={() => setSidebarOpen(!sidebarOpen)}
                    >
                      {sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </Button>
                    <div>
                      <h1 className="text-3xl font-bold text-foreground">Create New Unit</h1>
                      <p className="text-muted-foreground">
                        Add a new academic unit to the repository system
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Form Card */}
              <Card className="animate-fade-in">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="w-5 h-5" />
                    Unit Information
                  </CardTitle>
                  <CardDescription>
                    Enter the details for the new academic unit. The unit code should be a short identifier
                    (e.g., CAS for College of Arts and Sciences).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <UnitForm
                    onSubmit={handleFormSubmit}
                    onCreated={handleUnitCreated}
                    onCancel={handleCancel}
                  />
                </CardContent>
              </Card>
            </div>
          </main>
        </div>
      </div>
    </ClientOnly>
  );
}
