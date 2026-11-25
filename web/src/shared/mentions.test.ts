import { expect, it } from "vitest";
import { conversationPeople } from "./mentions";

it("offers commenters and actors but not commit authors, who may be git names without a login", () => {
  expect(
    conversationPeople({
      author: "alice",
      assignees: [],
      timeline: [
        {
          kind: "commit", oid: "1", abbreviatedOid: "1", headline: "Fix", author: "John Doe",
          committedAt: "2026-01-01T00:00:00Z", verified: false, status: null, url: "",
        },
        { kind: "comment", id: "IC_1", author: "carol", body: "Hi", createdAt: "2026-01-01T01:00:00Z", reactions: [] },
        { kind: "labeled", actor: "dave", createdAt: "2026-01-01T02:00:00Z", label: { name: "bug", color: "d73a4a" } },
      ],
      participants: [],
      viewer: "me",
    }),
  ).toEqual(["alice", "carol", "dave"]);
});
