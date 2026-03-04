'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Unit } from '@/lib/api/types';
import AuthService from '@/lib/services/auth-service';
import { Building2, Save, X } from 'lucide-react';

interface UnitFormProps {
  initialData?: Unit | null;
  onSubmit: (unit: Unit) => void;
  onCreated?: (unit: Unit) => void; // Callback when a new unit is created
  onCancel: () => void;
}

export function UnitForm({ initialData, onSubmit, onCreated, onCancel }: UnitFormProps) {
  const { toast } = useToast();
  const [name, setName] = useState(initialData?.name || '');
  const [code, setCode] = useState(initialData?.code || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = 'Unit name is required';
    }

    if (code.trim() && code.length > 10) {
      newErrors.code = 'Unit code must be 10 characters or less';
    } else if (code.trim() && !/^[A-Z0-9 _-]+$/.test(code)) {
      newErrors.code = 'Unit code can only contain uppercase letters, numbers, spaces, underscores, and hyphens';
    }

    if (description.length > 500) {
      newErrors.description = 'Description must be 500 characters or less';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const token = await AuthService.getAccessToken();
      if (!token) {
        throw new Error('No authentication token found');
      }

      const unitData = {
        name: name.trim(),
        code: code.trim() ? code.trim().toUpperCase() : undefined,
        description: description.trim(),
      };

      let response;
      if (initialData) {
        // Update existing unit
        response = await fetch(`/api/units/${initialData.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(unitData),
        });
      } else {
        // Create new unit
        response = await fetch('/api/units', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(unitData),
        });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to ${initialData ? 'update' : 'create'} unit: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      onSubmit(result.unit);

      toast({
        title: `Unit ${initialData ? 'updated' : 'created'} successfully`,
        description: `The unit "${result.unit.name}" has been ${initialData ? 'updated' : 'added'} to the system.`,
      });

      // If it's a new unit, call the onCreated callback
      if (!initialData && onCreated) {
        onCreated(result.unit);
      }

      // Reset form
      setName('');
      setCode('');
      setDescription('');
      setErrors({});
    } catch (error) {
      console.error(`Error ${initialData ? 'updating' : 'creating'} unit:`, error);
      toast({
        title: `Failed to ${initialData ? 'update' : 'create'} unit`,
        description: error instanceof Error ? error.message : 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-2xl mx-auto border-0 shadow-xl bg-gradient-to-br from-background to-muted">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold">
              {initialData ? 'Edit Unit' : 'Create New Unit'}
            </CardTitle>
            <CardDescription className="mt-1">
              {initialData
                ? 'Update the details for this academic unit.'
                : 'Add a new academic unit to the repository system. All fields are required unless marked optional.'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="name" className="text-base">
                  Unit Name <span className="text-destructive">*</span>
                </Label>
              </div>
              <div className="relative">
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter full unit name (e.g., College of Arts and Sciences)"
                  disabled={loading}
                  className="py-5 text-lg"
                />
              </div>
              {errors.name && (
                <p className="text-sm text-destructive flex items-center gap-1 mt-1">
                  <X className="w-4 h-4" /> {errors.name}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                The full name of the academic unit (e.g., College of Arts and Sciences)
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="code" className="text-base">
                  Unit Code
                </Label>
              </div>
              <div className="relative">
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="Enter unit code (e.g., CAS)"
                  disabled={loading}
                  maxLength={10}
                  className="py-5 text-lg"
                />
              </div>
              {errors.code && (
                <p className="text-sm text-destructive flex items-center gap-1 mt-1">
                  <X className="w-4 h-4" /> {errors.code}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Short code for the unit (max 10 characters, uppercase letters, numbers, spaces, underscores, and hyphens only)
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="description" className="text-base">
                  Description
                </Label>
              </div>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Enter unit description (optional)"
                disabled={loading}
                maxLength={500}
                rows={4}
                className="py-3"
              />
              {errors.description && (
                <p className="text-sm text-destructive flex items-center gap-1 mt-1">
                  <X className="w-4 h-4" /> {errors.description}
                </p>
              )}
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground mt-1">
                  Brief description of the unit (max 50 characters)
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {description.length}/500
                </p>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-6 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={loading}
              className="px-6"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="px-6 bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary shadow-md"
            >
              {loading ? (
                <>
                  <span className="mr-2">Processing...</span>
                  <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  {initialData ? 'Update Unit' : 'Create Unit'}
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}