/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  staticPageGenerationTimeout: 1000,
  images: {
     unoptimized: true,
     remotePatterns: [
       // Supabase storage: configure NEXT_PUBLIC_SUPABASE_HOSTNAME in your environment
       // to match your project's Supabase hostname (e.g. xyzabc.supabase.co)
       {
         protocol: 'https',
         hostname: process.env.NEXT_PUBLIC_SUPABASE_HOSTNAME || 'mydcfacggxluyljslcbp.supabase.co',
         port: '',
         pathname: '/storage/v1/object/public/**',
       },
       // Azure Blob Storage: allow any *.blob.core.windows.net hostname for file previews
       {
         protocol: 'https',
         hostname: '*.blob.core.windows.net',
         port: '',
         pathname: '/**',
       },
       // Localhost (development only)
       ...(process.env.NODE_ENV !== 'production' ? [{
         protocol: 'http',
         hostname: 'localhost',
         port: '3000',
         pathname: '/**',
       }] : []),
     ],
     // Set reasonable defaults for image optimization
     deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
     imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
     dangerouslyAllowSVG: false,
     contentSecurityPolicy: "script-src 'self' blob:; object-src 'none';",
   },
   // Enable compression for faster loading
   compress: true,
   // Enable experimental features that improve performance
   experimental: {
     optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
   },
}

export default nextConfig
