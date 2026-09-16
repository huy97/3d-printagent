import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
}) {
  const items = Object.fromEntries(options.map((option) => [option.value, option.label]))
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange((next as string | null) ?? value)}
    >
      <SelectTrigger className={cn('w-full', className)}>
        <SelectValue>{(current) => items[current as string] ?? placeholder ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
