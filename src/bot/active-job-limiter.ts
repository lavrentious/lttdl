const DEFAULT_MAX_ACTIVE_JOBS_PER_USER = 4;

const activeJobsByUser = new Map<number, number>();

export function tryStartUserJob(
  userId: number,
  maxActiveJobs = DEFAULT_MAX_ACTIVE_JOBS_PER_USER,
): boolean {
  const activeJobs = activeJobsByUser.get(userId) || 0;
  if (activeJobs >= maxActiveJobs) {
    return false;
  }

  activeJobsByUser.set(userId, activeJobs + 1);
  return true;
}

export function finishUserJob(userId: number) {
  const activeJobs = activeJobsByUser.get(userId) || 0;
  if (activeJobs <= 1) {
    activeJobsByUser.delete(userId);
    return;
  }

  activeJobsByUser.set(userId, activeJobs - 1);
}

export function getActiveUserJobCount(userId: number): number {
  return activeJobsByUser.get(userId) || 0;
}

