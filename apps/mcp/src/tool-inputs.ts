import * as z from 'zod/v4';

export const eventTitleSchema = z.string().trim().min(2)
  .describe('Human-readable event label. Prefer a concise title; longer titles are preserved in full.');

const reflectionItems = z.union([
  z.string().trim().min(2).transform(value => [value]),
  z.array(z.string().trim().min(2))
]).default([]);

export const reflectionInputSchema = z.object({
  executionId: z.string().uuid(),
  whatWorked: reflectionItems.describe('Successful approaches. Send a quoted JSON string or an array of quoted strings.'),
  whatFailed: reflectionItems.describe('Failed attempts. Send a quoted JSON string or an array of quoted strings.'),
  assumptions: reflectionItems.describe('Unverified assumptions. Send a quoted JSON string or an array of quoted strings.'),
  lessonsLearned: reflectionItems.describe('Reusable process lessons, not product facts.'),
  suggestedImprovements: reflectionItems.describe('Concrete improvements for future executions.'),
  recommendation: reflectionItems.describe('Optional recommendations, appended to suggestedImprovements.'),
  title: eventTitleSchema.optional(),
  reflectionType: z.string().trim().min(2).optional(),
  confidence: z.number().min(0).max(1).optional()
});
