"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

export default function UnitPage() {
  const router = useRouter();
  const params = useParams();
  const unitId = params.id as string;

  useEffect(() => {
    if (unitId) {
      router.replace(`/repository?unit=${unitId}`);
    } else {
      router.replace('/repository');
    }
  }, [unitId, router]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="animate-pulse flex flex-col items-center">
        <div className="h-8 w-8 rounded-full border-4 border-[#2B4385] border-t-transparent animate-spin mb-4"></div>
        <p className="text-gray-500">Loading unit repository...</p>
      </div>
    </div>
  );
}
