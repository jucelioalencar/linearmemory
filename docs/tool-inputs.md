# Event and reflection inputs

`add_execution_event` preserves long titles. Prefer concise labels and put details in `description`.

`record_reflection` accepts either a JSON string or an array of JSON strings for each learning field. `recommendation` is appended to `suggestedImprovements`; optional `title` and `reflectionType` are retained in the reflection event.

Example:

```json
{
  "executionId": "c42199ec-c3be-4851-a377-f60e16b00393",
  "whatWorked": ["Read the decision before editing."],
  "whatFailed": ["The image export was cropped."],
  "assumptions": ["The export size limit has not been measured."],
  "suggestedImprovements": ["Inspect the final image after each export."],
  "confidence": 0.85
}
```

Always quote text values. Use a JSON serializer to escape quotes, newlines and Windows backslashes. Malformed JSON is rejected by the calling client before the tool handler runs; retry with valid JSON. The server cannot repair a request it never receives.
