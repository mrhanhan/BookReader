/**
 * Common zones offered by the settings page. The list is a convenience, not a
 * whitelist: the server accepts any IANA zone the runtime knows.
 */
export const TIMEZONE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Asia/Shanghai', label: '中国标准时间（北京）' },
  { value: 'Asia/Hong_Kong', label: '香港' },
  { value: 'Asia/Taipei', label: '台北' },
  { value: 'Asia/Tokyo', label: '东京' },
  { value: 'Asia/Seoul', label: '首尔' },
  { value: 'Asia/Singapore', label: '新加坡' },
  { value: 'Asia/Kolkata', label: '印度标准时间' },
  { value: 'Europe/London', label: '伦敦' },
  { value: 'Europe/Paris', label: '巴黎' },
  { value: 'Europe/Berlin', label: '柏林' },
  { value: 'America/New_York', label: '纽约' },
  { value: 'America/Chicago', label: '芝加哥' },
  { value: 'America/Los_Angeles', label: '洛杉矶' },
  { value: 'Australia/Sydney', label: '悉尼' },
  { value: 'UTC', label: '协调世界时（UTC）' },
];
