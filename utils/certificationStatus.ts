// A "certification on file" means at least one entry in the employee's
// certifications array has an expiration date set. A newly added/imported
// employee whose Lifeguard certification hasn't been entered yet is left out
// of inservice-hour compliance tracking entirely — they shouldn't show up as
// "zero hours"/non-compliant just because nobody has gotten to their
// paperwork. Once a certification with an expiration date is added, they're
// picked up automatically the next time compliance is computed. See
// complianceController.ts, routes/dashboard.ts, routes/reports.ts, and
// employeeSelfServiceController.ts.
export function hasCertificationOnFile(data: any): boolean {
  const certifications = Array.isArray(data?.certifications) ? data.certifications : [];
  return certifications.some((c: any) => c && c.expirationDate);
}
