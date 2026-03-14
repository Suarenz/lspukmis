"use client"

import type React from "react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Image from "next/image"
import { Mail, Lock, Eye, EyeOff, User as UserIcon, Building, Info, CheckCircle2, Shield, BookOpen, GraduationCap, XCircle } from "lucide-react"

export default function LoginPage() {
  const { login, isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  
  // UI State
  const [isLoginView, setIsLoginView] = useState(true)
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  
  // Form State
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  // Register specific
  const [name, setName] = useState("")
  const [idNumber, setIdNumber] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [unitId, setUnitId] = useState("")
  const [role, setRole] = useState("")

  // Units for dropdown
  const [units, setUnits] = useState<{ id: string; name: string; code: string }[]>([])

  useEffect(() => {
    setMounted(true)
    fetchUnits()
  }, [])

  useEffect(() => {
    if (!isLoading && isAuthenticated && mounted) {
      router.push("/dashboard")
    }
  }, [isAuthenticated, isLoading, router, mounted])

  const fetchUnits = async () => {
    try {
      const res = await fetch('/api/units/public')
      if (res.ok) {
        const data = await res.json()
        setUnits(data.units || [])
      }
    } catch (err) {
      console.error("Failed to fetch units:", err)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    setLoading(true)

    const result = await login(email, password)
    if (result.success) {
      router.push("/dashboard")
    } else {
      setError(result.error || "Invalid email or password")
      setLoading(false)
    }
  }
  
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccess("")
    
    if (password !== confirmPassword) {
      setError("Passwords do not match")
      return
    }
    
    if (!unitId) {
      setError("Please select a unit")
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name,
          idNumber,
          unitId,
          role
        })
      })
      
      const data = await res.json()
      
      if (res.ok) {
        setSuccess("Registration successful! You can now log in.")
        setIsLoginView(true)
        // Reset register fields
        setPassword("")
        setConfirmPassword("")
        setError("")
      } else {
        setError(data.error || "Registration failed")
      }
    } catch (err) {
      setError("An error occurred during registration")
    } finally {
      setLoading(false)
    }
  }

  const toggleView = () => {
    setIsLoginView(!isLoginView)
    setError("")
    setSuccess("")
  }

  const LoadingSpinner = ({ message }: { message: string }) => (
    <div className="min-h-screen bg-linear-to-br from-slate-50 via-blue-50 to-indigo-100 flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-200/30 rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-indigo-200/30 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>
      
      <div className="text-center relative z-10">
        <div className="relative">
          <div className="w-24 h-24 flex items-center justify-center mx-auto mb-6 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={90}
              height={90}
              className="w-24 h-24 object-contain"
            />
          </div>
          <div className="absolute inset-0 w-24 h-24 mx-auto border-4 border-transparent border-t-slate-400 rounded-full animate-spin" style={{ animationDuration: '1.5s' }} />
        </div>
        <p className="text-xl text-slate-700 font-medium">{message}</p>
        <div className="flex justify-center gap-1 mt-4">
          <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  )

  if (isLoading || !mounted) {
    return <LoadingSpinner message="Loading..." />
  }

  if (isAuthenticated && mounted) {
    return <LoadingSpinner message="Redirecting to dashboard..." />
  }

  return (
    <div className="h-screen w-full flex overflow-hidden bg-slate-50">
      {/* Left Column - Branding (Hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col items-center justify-center p-12">
        <div className="absolute inset-0 z-0">
          <Image 
            src="/LSPU PHOTO.png" 
            alt="LSPU Campus" 
            fill 
            className="object-cover"
            priority
          />
          {/* Gradient Overlay for text legibility */}
          <div className="absolute inset-0 bg-linear-to-t from-[#1a2f64] via-[#2B4385]/80 to-[#2B4385]/40 mix-blend-multiply" />
          <div className="absolute inset-0 bg-[#2B4385]/30 backdrop-blur-[2px]" />
        </div>
        
        <div className="relative z-10 text-center text-white space-y-6 max-w-xl">
          <div className="flex justify-center mb-4">
            <div className="w-32 h-32 flex items-center justify-center p-2">
              <Image
                src="/LSPULogo.png"
                alt="LSPU Logo"
                width={128}
                height={128}
                className="object-contain"
                priority
              />
            </div>
          </div>
          
          <h1 className="text-4xl xl:text-5xl font-bold leading-tight tracking-tight drop-shadow-md">
            Knowledge Management
            <span className="block text-blue-200 mt-2">Information System</span>
          </h1>
          
          <p className="text-lg xl:text-xl text-slate-200 font-medium tracking-wide drop-shadow">
            Laguna State Polytechnic University
          </p>

          <div className="pt-8">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="bg-white/10 hover:bg-white/20 text-white border-white/30 backdrop-blur-md rounded-full h-12 w-12 transition-all hover:scale-110">
                  <Info className="h-6 w-6" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl bg-white/95 backdrop-blur-xl">
                <DialogHeader>
                  <DialogTitle className="text-2xl font-bold text-[#2B4385] flex items-center gap-2">
                    <Building className="h-6 w-6" /> About LSPU
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-6 mt-4 max-h-[60vh] overflow-y-auto pr-2">
                  <div className="space-y-2">
                    <h3 className="font-bold border-b pb-2 flex items-center gap-2 text-slate-800">
                      <Shield className="h-5 w-5 text-indigo-600" /> Vision
                    </h3>
                    <p className="text-slate-600 leading-relaxed">
                      LSPU is a center of technological innovation that promotes interdisciplinary learning, sustainable utilization of resources, collaboration and partnership with the community and stakeholders.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold border-b pb-2 flex items-center gap-2 text-slate-800">
                      <GraduationCap className="h-5 w-5 text-amber-600" /> Mission
                    </h3>
                    <p className="text-slate-600 leading-relaxed">
                      LSPU, driven by progressive leadership, is a premier institution providing technology-mediated agriculture, fisheries and other related disciplines significantly contributing to the growth and development of the region and nation.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-bold border-b pb-2 flex items-center gap-2 text-slate-800">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" /> Quality Policy
                    </h3>
                    <p className="text-slate-600 leading-relaxed">
                      LSPU provides quality education and services for sustainable development prioritizing stakeholder's satisfaction through continuous improvement in instruction, research, extension and production.
                    </p>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Right Column - Auth Panel */}
      <div className="w-full lg:w-1/2 h-full overflow-y-auto bg-slate-50 flex flex-col justify-center relative">
        {/* Mobile Header (Only visible on small screens) */}
        <div className="lg:hidden flex flex-col items-center justify-center p-6 bg-[#2B4385] text-white">
          <Image
            src="/LSPULogo.png"
            alt="LSPU Logo"
            width={70}
            height={70}
            className="mb-2 object-contain"
          />
          <h1 className="text-xl font-bold text-center">KMIS</h1>
          <p className="text-sm text-blue-200">Laguna State Polytechnic University</p>
        </div>

        <div className="w-full max-w-md mx-auto p-6 md:p-8 shrink-0">
          <Card className="border-0 shadow-2xl bg-white/80 backdrop-blur-xl rounded-2xl">
            <CardHeader className="space-y-3 pb-6">
              <CardTitle className="text-3xl font-bold text-[#2B4385] text-center">
                {isLoginView ? "Welcome Back" : "Join the Portal"}
              </CardTitle>
              <CardDescription className="text-center text-slate-500 text-base">
                {isLoginView 
                  ? "Sign in to access your knowledge repository"
                  : "Register with your institutional credentials"
                }
              </CardDescription>
            </CardHeader>
            <CardContent>
              {error && (
                <div className="mb-6 p-4 bg-red-50/80 backdrop-blur-sm border border-red-200 rounded-xl flex items-start gap-3 text-red-700 animate-in fade-in zoom-in-95 duration-300">
                  <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}
              {success && (
                <div className="mb-6 p-4 bg-emerald-50/80 backdrop-blur-sm border border-emerald-200 rounded-xl flex items-start gap-3 text-emerald-700 animate-in fade-in zoom-in-95 duration-300">
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{success}</p>
                </div>
              )}

              {isLoginView ? (
                // --- LOGIN FORM ---
                <form onSubmit={handleLogin} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-slate-700 font-medium">Email Address</Label>
                    <div className="relative group">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-5 h-5" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="your.name@lspu.edu.ph"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        className="pl-12 h-12 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl transition-all"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password" className="text-slate-700 font-medium">Password</Label>
                    </div>
                    <div className="relative group">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-5 h-5" />
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="pl-12 pr-12 h-12 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                  <Button
                    type="submit"
                    className="w-full h-12 text-base font-semibold rounded-xl bg-[#2B4385] hover:bg-[#1a2f64] hover:shadow-lg hover:-translate-y-0.5 transition-all mt-4"
                    disabled={loading || !email || !password}
                  >
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        Signing in...
                      </div>
                    ) : (
                      "Sign In"
                    )}
                  </Button>
                </form>
              ) : (
                // --- REGISTER FORM ---
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-slate-700 font-medium">Full Name</Label>
                    <div className="relative group">
                      <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-5 h-5" />
                      <Input
                        id="name"
                        type="text"
                        placeholder="Juan Dela Cruz"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        className="pl-12 h-11 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="idNumber" className="text-slate-700 font-medium">ID Number</Label>
                    <div className="relative group">
                      <BookOpen className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-5 h-5" />
                      <Input
                        id="idNumber"
                        type="text"
                        placeholder="0320-12345"
                        value={idNumber}
                        onChange={(e) => setIdNumber(e.target.value)}
                        required
                        className="pl-12 h-11 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="reg-email" className="text-slate-700 font-medium">Email Address</Label>
                    <div className="relative group">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-5 h-5" />
                      <Input
                        id="reg-email"
                        type="email"
                        placeholder="your.name@lspu.edu.ph"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        className="pl-12 h-11 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="reg-password" className="text-slate-700 font-medium">Password</Label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-4 h-4" />
                        <Input
                          id="reg-password"
                          type="password"
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          className="pl-10 h-11 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-password" className="text-slate-700 font-medium">Confirm</Label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors w-4 h-4" />
                        <Input
                          id="confirm-password"
                          type="password"
                          placeholder="••••••••"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          required
                          className="pl-10 h-11 bg-slate-50 border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-xl"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="role" className="text-slate-700 font-medium">Role</Label>
                    <Select onValueChange={setRole} defaultValue={role} required>
                      <SelectTrigger className="h-11 bg-slate-50 border-slate-200 focus:ring-blue-500/20 rounded-xl">
                        <SelectValue placeholder="Select your role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FACULTY">Faculty</SelectItem>
                        <SelectItem value="PERSONNEL">Personnel</SelectItem>
                        <SelectItem value="STUDENT">Student</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="unit" className="text-slate-700 font-medium">Assigned Unit</Label>
                    <Select onValueChange={setUnitId} defaultValue={unitId} required>
                      <SelectTrigger className="h-11 bg-slate-50 border-slate-200 focus:ring-blue-500/20 rounded-xl">
                        <SelectValue placeholder="Select your unit/department" />
                      </SelectTrigger>
                      <SelectContent>
                        {units.length === 0 ? (
                          <SelectItem value="loading" disabled>Loading units...</SelectItem>
                        ) : (
                          units.map(unit => (
                            <SelectItem key={unit.id} value={unit.id}>
                              {unit.name} ({unit.code})
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  <Button
                    type="submit"
                    className="w-full h-12 text-base font-semibold rounded-xl bg-[#2B4385] hover:bg-[#1a2f64] hover:shadow-lg hover:-translate-y-0.5 transition-all mt-6"
                    disabled={loading || !name || !idNumber || !email || !password || !confirmPassword || !unitId || !role}
                  >
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        Creating Account...
                      </div>
                    ) : (
                      "Register Now"
                    )}
                  </Button>
                </form>
              )}
            </CardContent>
            
            <CardFooter className="flex flex-col space-y-4 pt-0">
              <div className="relative w-full">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white text-slate-500">
                    {isLoginView ? 'New to the system?' : 'Already have an account?'}
                  </span>
                </div>
              </div>
              <Button 
                variant="outline" 
                className="w-full h-11 font-medium bg-slate-50 hover:bg-slate-100 rounded-xl border-slate-200 transition-colors"
                onClick={toggleView}
              >
                {isLoginView ? 'Create an Account' : 'Sign in instead'}
              </Button>
            </CardFooter>
          </Card>
          
          <p className="text-center text-slate-400 text-sm mt-8">
            &copy; {new Date().getFullYear()} Laguna State Polytechnic University. <br className="lg:hidden" /> All rights reserved.
          </p>
        </div>
      </div>
    </div>
  )
}
