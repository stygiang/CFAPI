import RE2 from "re2";

const maxPatternLength = 200;

export const isSafeRegex = (pattern: string): boolean => {
  if (pattern.length > maxPatternLength) return false;
  try {
    new RE2(pattern);
    return true;
  } catch {
    return false;
  }
};

export const safeRegexTest = (pattern: string, value: string): boolean => {
  if (!isSafeRegex(pattern)) return false;
  try {
    const regex = new RE2(pattern, "i");
    return regex.test(value);
  } catch {
    return false;
  }
};
