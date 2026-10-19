export function formatSize(numBytes) {
  let size = Number(numBytes || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  for (const unit of units) {
    if (size < 1024 || unit === "TB") {
      return unit === "B"
        ? `${Math.trunc(size)} ${unit}`
        : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} PB`;
}

export function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
