/** Human duration for cards: whole minutes, hours spelled out. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return '0 分钟';
  }
  if (seconds < 60) {
    return '不足 1 分钟';
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${minutes} 分钟`;
  }
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** Chart label: zero stays explicit, anything under a minute is a prompt. */
export function formatChartDuration(seconds: number): string {
  if (seconds <= 0) {
    return '0 分钟';
  }
  if (seconds < 60) {
    return '不足 1 分钟';
  }
  return `${Math.floor(seconds / 60)} 分钟`;
}

/** `10月19日` from a `YYYY-MM-DD` label; the label is already local. */
export function formatChartDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}
