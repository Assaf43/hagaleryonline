/** "dana@example.test" → "d***@example.test" (spec §8: no full recipient in the log outside the mock body). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** "0501234567" / "+972501234567" → "050-***-4567". */
export function maskPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  if (digits.length < 9) return '***';
  return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
}
