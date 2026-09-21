import type { ComponentProps, ReactNode } from 'react'
import styles from './Button.module.css'

/*
 * Extends the intrinsic <button> props rather than listing a handful by hand.
 *
 * The old signature named six props and forwarded nothing else, so a caller
 * that needed `title`, `aria-expanded`, `aria-label`, `form` or a `ref` could
 * not use this component at all and had to hand-roll a <button> plus a copy of
 * the styles. In React 19 `ref` is an ordinary prop, so ComponentProps<'button'>
 * covers it too and no forwardRef is needed.
 */
export interface ButtonProps extends ComponentProps<'button'> {
  children: ReactNode
  size?: 'normal' | 'small'
}

export default function Button({
  children,
  type = 'button',
  disabled = false,
  size = 'normal',
  className = '',
  ...rest
}: ButtonProps) {
  const buttonClass = `${styles.button} ${size === 'small' ? styles.small : ''} ${className}`

  return (
    <button className={buttonClass} type={type} disabled={disabled} {...rest}>
      {children}
    </button>
  )
}
