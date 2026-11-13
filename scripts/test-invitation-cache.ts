import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchInvitationList, invalidateInvitationData, readCachedInvitationList } from "../lib/invitation-data"
import { invalidateSheetsCache, withSheetsCache } from "../lib/sheets-cache"

test("empty guest responses replace old browser lists and remain empty on later failures", async () => {
  const originalFetch = globalThis.fetch
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = new Map<string, string>([
    ["invitation-data:/api/guests", JSON.stringify([{ name: "Old Guest" }])],
    ["invitation-data:/api/guests?list=two", JSON.stringify([{ name: "Other List Guest" }])],
  ])
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  } })
  invalidateInvitationData()
  try {
    assert.deepEqual(readCachedInvitationList("/api/guests"), [{ name: "Old Guest" }])
    let requests = 0
    globalThis.fetch = async () => {
      requests += 1
      return Response.json([])
    }
    assert.deepEqual(await fetchInvitationList("/api/guests", { allowStale: false }), [])
    assert.equal(storage.get("invitation-data:/api/guests"), "[]")
    assert.deepEqual(readCachedInvitationList("/api/guests"), [])
    assert.deepEqual(await fetchInvitationList("/api/guests"), [])
    assert.equal(requests, 1, "A valid empty list should use the normal cache TTL")
    assert.deepEqual(readCachedInvitationList("/api/guests?list=two"), [{ name: "Other List Guest" }])

    globalThis.fetch = async () => { throw new Error("Offline") }
    assert.deepEqual(await fetchInvitationList("/api/guests", { reload: true }), [])
    await assert.rejects(fetchInvitationList("/api/guests?list=two", {
      reload: true, allowStale: false,
    }), /Offline/, "RSVP must not suggest saved names when the current list cannot be checked")

    globalThis.fetch = async () => Response.json([{ name: "Current Guest" }])
    assert.deepEqual(await fetchInvitationList("/api/guests", { reload: true, allowStale: false }), [{ name: "Current Guest" }])
  } finally {
    globalThis.fetch = originalFetch
    invalidateInvitationData()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

test("an empty Google sheet replaces old server guest cache entries", async () => {
  const key = "test-empty-guests"
  invalidateSheetsCache(key)
  try {
    assert.deepEqual(await withSheetsCache(key, async () => [{ name: "Old Guest" }], -1), [{ name: "Old Guest" }])
    await withSheetsCache(key, async () => [])
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(await withSheetsCache(key, async () => {
      throw new Error("The verified empty result should already be cached")
    }), [])
  } finally { invalidateSheetsCache(key) }
})
