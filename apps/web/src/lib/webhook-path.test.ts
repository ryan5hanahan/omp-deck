import { expect, test } from "bun:test";

import schema from "../../../../packages/protocol/src/schemas/trigger-webhook.json";
import { newWebhookPath } from "./webhook-path";

test("generated webhook paths always match the schema's path pattern", () => {
	const pattern = new RegExp(schema.properties.webhook.properties.path.pattern);
	for (let i = 0; i < 1000; i++) expect(newWebhookPath()).toMatch(pattern);
});
