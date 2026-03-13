const fs = require('fs');

const historyDir = 'c:/Users/ADMIN PC/AppData/Roaming/Code/User/History/-48886d0d';
const entries = JSON.parse(fs.readFileSync(historyDir + '/entries.json', 'utf8')).entries;
const goodEntry = entries.find(e => e.id === 'kW7O.tsx') || entries[entries.length - 6];

let content = fs.readFileSync(historyDir + '/' + goodEntry.id, 'utf8');

// 1. Categories
content = content.replace(
  'const categories = ["all", "Other files", "Research", "Academic", "Policy", "Extension", "Teaching"];',
  'const categories = ["all", "Other files", "QPRO"];'
);

// 2. SecureThumbnail
const secureThumbnailCode = \const isImageFile = (fileName: string) => {
    const ext = fileName?.split('.').pop()?.toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '');
};

const SecureThumbnail = ({ doc, className }: { doc: any; className: string }) => {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  
  useEffect(() => {
    let active = true;
    const fetchToken = async () => {
      try {
        const token = await AuthService.getAccessToken();
        if (active && token) {
          setImgUrl(\\\/api/documents/\/view-proxy?token=\\\\);
        }
      } catch (err) {
        console.error("Failed to load thumbnail", err);
      }
    };
    fetchToken();
    return () => { active = false; };
  }, [doc.id]);

  if (!imgUrl) {
    return <div className={\\\g-gray-100 animate-pulse \\\\} />;
  }

  return <img src={imgUrl} alt={doc.title} className={className} />;
};\;

content = content.replace(
  /const isImageFile = [\s\S]*?includes\(ext \|\| ''\);\n};/,
  secureThumbnailCode
);

// 3. Table Header
content = content.replace(
  /<th className="px-6 py-4 font-medium hidden md:table-cell">Category<\/th>\s*<th className="px-6 py-4 font-medium hidden sm:table-cell">Version<\/th>/,
  '<th className="px-6 py-4 font-medium hidden md:table-cell">Date Uploaded</th>'
);

// 4. List View Row
content = content.replace(
  /<td className="px-6 py-4 hidden md:table-cell">[\s\S]*?<\/td>\s*<td className="px-6 py-4 hidden sm:table-cell text-gray-500">\s*v\{doc\.version\}\s*<\/td>/,
  '<td className="px-6 py-4 hidden md:table-cell text-gray-500">\n                                {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-"}\n                              </td>'
);

// 5. Grid View text
content = content.replace(
  /<p className="text-xs text-gray-500 mb-2">v\{doc\.version\} • \{formatFileSize\(doc\.fileSize\)\}<\/p>/,
  '<p className="text-xs text-gray-500 mb-2">{doc.createdAt ? new Date(doc.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-"} • {formatFileSize(doc.fileSize)}</p>'
);

// 6. Grid View pill
content = content.replace(
  /\{doc\.category && doc\.category !== "Other files" && \(\s*<span\n\s*className="px-2\.5 py-1 text-\[11px\] font-medium rounded-full bg-gray-100 text-gray-600"\n\s*>\n\s*\{doc\.category\}\n\s*<\/span>\n\s*\)\}/,
  ''
);

// 7. Update ListView images
content = content.replace(
  /<img\s+src=\{doc\.fileUrl\}\s+alt=\{doc\.title\}\s+className="w-10 h-10 min-w-10 rounded-lg object-cover border border-gray-100 shrink-0"\s*\/>/,
  '<SecureThumbnail doc={doc} className="w-10 h-10 min-w-10 rounded-lg object-cover border border-gray-100 shrink-0" />'
);

// 8. Update GridView images
content = content.replace(
  /<img\s+src=\{doc\.fileUrl\}\s+alt=\{doc\.title\}\s+className="w-12 h-12 min-w-12 rounded-lg object-cover border border-gray-100 shrink-0"\s*\/>/,
  '<SecureThumbnail doc={doc} className="w-12 h-12 min-w-12 rounded-lg object-cover border border-gray-100 shrink-0" />'
);

fs.writeFileSync('app/repository/page.tsx', content, 'utf8');
console.log('Restoration and Patching Completed without Encoding Errors!');