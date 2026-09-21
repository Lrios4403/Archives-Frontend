import type { InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

// Forwards the full set of native input attributes. The previous hand-written
// prop list (type/value/onChange/placeholder/className) silently discarded
// everything else a caller passed, so the search bar's name, autoFocus,
// autoComplete and disabled never reached the DOM. `name` mattered most: without
// it the no-JS <form method="get" action="/warcs/search"> fallback submitted with
// no q parameter at all, so search only worked with JavaScript enabled.
type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export default function Input({ type = 'text', className = '', ...rest }: InputProps) {
  return (
    <input
      type={type}
      className={`${styles.input} ${className}`}
      {...rest}
    />
  )
}
