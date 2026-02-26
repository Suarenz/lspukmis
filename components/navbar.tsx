"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Menu, X, Search, MessageSquare, BarChart3, LogOut, UserRound, File, ClipboardCheck, Home, Plus } from "lucide-react"
import Image from "next/image"
import { cn } from "@/lib/utils"

export function Navbar() {
  const { user, logout, isLoading, isAuthenticated } = useAuth()
  const pathname = usePathname()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Don't render if user is not authenticated and not loading (meaning auth check is complete but user is not logged in)
  if (!isAuthenticated && !isLoading) {
    return null;
  }

  // Show loading state with skeleton if user is authenticated but still loading
  if (isLoading) {
    return (
      <nav className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 border-b border-primary/20 shadow-sm">
        <div className="flex justify-between items-center h-16 px-4 sm:px-6 lg:px-8">
          {/* Left Side: Logo and Title (Loading skeleton) */}
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="flex items-center gap-2 group">
              <div className="w-12 h-12 flex items-center justify-center group-hover:scale-105 transition-transform overflow-hidden">
                <Image
                  src="/LSPULogo.png"
                  alt="LSPU Logo"
                  width={48}
                  height={48}
                  className="object-contain"
                  priority
                />
              </div>
              <div className="hidden sm:flex sm:flex-col sm:items-start ml-2">
                <div className="text-xl font-bold bg-linear-to-r from-primary to-blue-700 bg-clip-text text-transparent">LSPU KMIS</div>
                <div className="text-xs text-muted-foreground -mt-1">Knowledge Management Information System</div>
              </div>
            </Link>
          </div>
 
          {/* Center: Navigation Links (Loading skeleton) */}
          <div className="hidden md:flex items-center justify-center flex-1">
            <div className="flex items-center gap-1">
              <div className="h-10 w-24 bg-muted rounded animate-pulse mx-1"></div>
              <div className="h-10 w-20 bg-muted rounded animate-pulse mx-1"></div>
              <div className="h-10 w-20 bg-muted rounded animate-pulse mx-1"></div>
              <div className="h-10 w-24 bg-muted rounded animate-pulse mx-1"></div>
            </div>
          </div>
 
          {/* Right Side: User Profile (Loading skeleton) */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-muted animate-pulse"></div>
              <div className="hidden sm:block h-4 w-16 bg-muted rounded animate-pulse"></div>
              </div>
            <div className="h-10 w-10 bg-muted rounded-full animate-pulse"></div>
          </div>
        </div>
      </nav>
    );
  }
  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: Home },
    { name: "Repository", href: "/repository", icon: File },
    { name: "Search", href: "/search", icon: Search },
    ...(user?.role === "ADMIN" || user?.role === "FACULTY"
      ? [
          { name: "QPRO", href: "/qpro", icon: ClipboardCheck }
        ]
      : []),
  ]

  const getInitials = (name: string) => {
    const initials = name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
    
    // Avoid returning "AU" as initials, return first initial instead
    if (initials === "AU") {
      return initials.charAt(0);
    }
    return initials;
  }

  return (
    <nav className="sticky top-0 z-50 bg-white/95 backdrop-blur supports-backdrop-filter:bg-white/60 border-b border-gray-200 shadow-sm">
      <div className="flex justify-between items-center h-16 px-4 sm:px-6 lg:px-8">
        {/* Left Side: Logo and Title */}
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className="flex items-center gap-2 group">
            <div className="w-12 h-12 flex items-center justify-center group-hover:scale-105 transition-transform overflow-hidden">
              <Image
                src="/LSPULogo.png"
                alt="LSPU Logo"
                width={48}
                height={48}
                className="object-contain"
                priority
              />
            </div>
            <div className="hidden sm:flex sm:flex-col sm:items-start ml-2">
              <div className="text-xl font-bold" style={{ color: '#2B4385' }}>LSPU KMIS</div>
              <div className="text-xs text-gray-500 -mt-1">Knowledge Management Information System</div>
            </div>
          </Link>
        </div>

        {/* Center: Navigation Links */}
        <div className="hidden md:flex items-center justify-center flex-1">
          <div className="flex items-center gap-1">
            {navigation.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href
              return (
                <Link key={item.name} href={item.href}>
                  <Button
                    variant={isActive ? "secondary" : "ghost"}
                    className="gap-2"
                    style={isActive ? { color: '#2B4385', backgroundColor: 'rgba(43, 67, 133, 0.1)' } : {}}
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </Button>
                </Link>
              )
            })}
          </div>
        </div>

        {/* Right Side: Upload Button + User Profile */}
        <div className="flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2">
                <Avatar className="w-8 h-8">
                  <AvatarFallback className="text-sm flex items-center justify-center" style={{backgroundColor: 'rgba(43, 67, 133, 0.1)', color: '#2B4385'}}>
                    <UserRound className="w-4 h-4" />
                  </AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline text-sm text-gray-700">{user?.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col gap-1">
                  <div className="font-medium text-gray-900">{user?.name}</div>
                  <div className="text-xs text-gray-500">{user?.email}</div>
                  <div className="text-xs text-gray-500 capitalize">Role: {user?.role}</div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await logout();
                }}
                className="text-red-600"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-gray-200 animate-slide-in px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col gap-2">
              {navigation.map((item) => {
                const Icon = item.icon
                const isActive = pathname === item.href
                return (
                  <Link key={item.name} href={item.href} onClick={() => setMobileMenuOpen(false)}>
                    <Button
                      variant={isActive ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2"
                      style={isActive ? { color: '#2B4385', backgroundColor: 'rgba(43, 67, 133, 0.1)' } : {}}
                    >
                      <Icon className="w-4 h-4" />
                      {item.name}
                    </Button>
                  </Link>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </nav>
  )
}
