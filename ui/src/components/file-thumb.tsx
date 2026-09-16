import { useState } from 'react'
import { Box } from 'lucide-react'
import { mediaUrl, type LibraryFile } from '@/lib/api'
import { cn } from '@/lib/utils'

export function FileThumb({ file, className }: { file: LibraryFile; className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={cn('bg-muted/60 flex shrink-0 items-center justify-center overflow-hidden rounded-lg border', className)}>
      {file.hasThumbnail && !failed ? (
        <img
          src={mediaUrl(`/api/files/${encodeURIComponent(file.id)}/thumbnail`)}
          alt=""
          loading="lazy"
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Box className="text-muted-foreground size-1/2" strokeWidth={1.5} />
      )}
    </div>
  )
}
