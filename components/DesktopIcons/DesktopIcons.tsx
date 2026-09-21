import styles from './DesktopIcons.module.css'

const desktopIcons = [
  { icon: "🗂️", label: "My Archives" },
  { icon: "⚙️", label: "Settings" },
  { icon: "📊", label: "Statistics" },
]

export default function DesktopIcons() {
  return (
    <div className={styles.desktopIcons}>
      {desktopIcons.map((item, index) => (
        <div key={index} className={styles.desktopIcon}>
          <div className={styles.iconImage}>{item.icon}</div>
          <span className={styles.iconLabel}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}
