'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Building2, PlusCircle, Folder, Plus } from 'lucide-react';
import { Unit } from '@/lib/api/types';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

interface UnitSidebarProps {
  units: Unit[];
  currentUnit: string | null;
  onUnitSelect: (unitId: string | null) => void;
  userRole: string;
  userUnit: string | null; // Changed from userDepartment to userUnit for consistency with new naming
  canUpload?: boolean;
  onUploadClick?: () => void;
}

export function UnitSidebar({
  units,
  currentUnit,
  onUnitSelect,
  userRole,
  userUnit, // Changed from userDepartment to userUnit
  canUpload,
  onUploadClick
}: UnitSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isAdmin = userRole === 'ADMIN';
  const isUnitAdmin = userRole === 'UNIT_ADMIN' || userRole === 'ADMIN';

  return (
    <div className="w-64 bg-white border-r p-4 h-[calc(100vh-64px)] flex flex-col" style={{ boxShadow: '2px 0 4px rgba(0,0,0,0.05)' }}>
      {/* Upload Document Button */}
      {canUpload && onUploadClick && (
        <div className="mb-6">
          <Button
            onClick={onUploadClick}
            className="w-full rounded-full font-semibold bg-white text-[#2B4385] border border-gray-200 hover:bg-gray-50 flex items-center justify-center gap-2 transition-all duration-200"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}
          >
            <PlusCircle className="w-5 h-5" />
            Upload Document
          </Button>
        </div>
      )}

      {/* UNITS Section Header */}
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">
        DEPARTMENTS / UNITS
      </h3>

      {/* Scrollable Units List */}
      <div className="space-y-1 flex-1 overflow-y-auto pr-1
        [&::-webkit-scrollbar]:w-1.5 
        [&::-webkit-scrollbar-track]:bg-transparent 
        [&::-webkit-scrollbar-thumb]:bg-gray-200 
        [&::-webkit-scrollbar-thumb]:rounded-full 
        hover:[&::-webkit-scrollbar-thumb]:bg-gray-300 transition-colors"
      >
        <TooltipProvider>
          {units.map((unit) => {
            const isActive = currentUnit === unit.id;
            return (
            <div key={unit.id} className="mb-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    className={`w-full justify-start h-auto transition-all duration-200 max-w-full overflow-hidden relative px-4 py-3 rounded-lg group ${
                      isActive 
                        ? 'bg-[#EFF6FF]' 
                        : 'bg-transparent hover:bg-[#F9FAFB]'
                    }`}
                    onClick={() => {
                      onUnitSelect(unit.id);
                    }}
                  >
                    <Folder className={`w-5 h-5 mr-3 shrink-0 ${isActive ? 'text-[#2B4385]' : 'text-gray-400'}`} />
                    <div className="flex-1 text-left min-w-0 overflow-hidden">
                      <div className="flex items-center gap-1">
                        <div 
                          className={`font-semibold truncate text-[15px] ${isActive ? 'text-[#2B4385]' : 'text-gray-700'}`}
                        >
                          {unit.code || unit.name}
                        </div>
                      </div>
                      {unit.code && (
                        <div 
                          className={`mt-0.5 leading-tight truncate text-[13px] ${isActive ? 'text-[#2B4385]/80' : 'text-gray-500'}`}
                        >
                          {unit.name}
                        </div>
                      )}
                    </div>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{unit.name}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )})}
        </TooltipProvider>
      </div>

      {/* Add New Unit Button */}
      {(isAdmin || isUnitAdmin) && (
        <div className="mt-4 pt-4 sticky bottom-0 bg-white border-t border-gray-100">
          <Button
            variant="ghost"
            className="w-full gap-2 text-[#2B4385] border border-[#2B4385] hover:bg-[#EFF6FF] rounded-lg transition-colors"
            onClick={() => router.push('/units/new')}
          >
            <Plus className="w-4 h-4" />
            Add New Unit
          </Button>
        </div>
      )}
    </div>
  );
}
