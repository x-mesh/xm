// Synthetic finding fixtures test content/freshness rules without inventing successful review receipts.
// Real lifecycle admission and CLI approval are covered by x-review-budget.test.mjs.
import { verifyReviewFixContent } from '../../x-build/lib/x-build/verify.mjs';
await verifyReviewFixContent(process.argv.slice(3));
