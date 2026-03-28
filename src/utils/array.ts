export function zipArrays<T>(arrays: T[][][]): T[][] {
  if (!arrays.length) return [];
  return arrays[0]!.map((_, i) =>
    arrays
      .map((arr) => arr[i])
      .flat()
      .filter((x): x is T => x !== undefined),
  );
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }

  return result;
}
