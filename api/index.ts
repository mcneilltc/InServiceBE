// Vercel's officially-supported Node.js runtime only discovers functions
// under an `api/` directory at the project root — this app previously had
// no such folder, which likely meant Vercel was running it through some
// unpredictable fallback path instead of the documented one. Re-exporting
// the existing Express app here (unchanged) puts it on the supported path.
import app from '../app';

export default app;
