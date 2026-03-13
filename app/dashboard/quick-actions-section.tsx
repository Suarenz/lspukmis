"use client";

import { Button } from "@/components/ui/button";
import { BookOpen, Search } from "lucide-react";
import Link from "next/link";

export default function QuickActionsSection() {
  return (
    <div className="flex items-center justify-end gap-3 w-full">
      <Link href="/repository">
        <Button 
          className="bg-[#2B4385] hover:bg-[#2B4385]/90 text-white shadow-sm flex items-center gap-2"
        >
          <BookOpen className="w-4 h-4" />
          Browse Repository
        </Button>
      </Link>
      <Link href="/search">
        <Button 
          variant="outline"
          className="border-[#2B4385] text-[#2B4385] hover:bg-[#2B4385]/10 shadow-sm flex items-center gap-2 bg-white"
        >
          <Search className="w-4 h-4" />
          Search Knowledge
        </Button>
      </Link>
    </div>
  );
}
