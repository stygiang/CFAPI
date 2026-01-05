type CronTime = { minute: number; hour: number };

export const parseCronHourMinute = (cron: string): CronTime | null => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { minute, hour };
};

export const scheduleNextCron = (minute: number, hour: number): number => {
  const now = new Date();
  const next = new Date();
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setMinutes(minute);
  next.setHours(hour);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
};
