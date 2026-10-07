import { describe, expect, it } from "bun:test"
import { MemoryGateway } from "../src/memory/gateway"

const gateway = { enabled: true, gatewayURL: "http://127.0.0.1:11435" }
const identity = {
  endpoint: "http://localhost:11435/v1/",
  sessionID: "ses-one",
  projectID: "project-one",
  projectRoot: "C:\\Projects\\one",
  directory: "C:\\Projects\\one\\src",
  requestKind: "user" as const,
}

describe("Memory Gateway identity headers", () => {
  it("disables tools only for the managed local provider or matching Gateway endpoint", () => {
    const managed = { providerID: "memory-local", endpoint: identity.endpoint }
    expect(MemoryGateway.agentToolsDisabled(managed, gateway, "false")).toBe(true)
    expect(MemoryGateway.agentToolsDisabled(managed, gateway, "true")).toBe(false)
    expect(
      MemoryGateway.agentToolsDisabled({ providerID: "custom", endpoint: identity.endpoint }, gateway, "false"),
    ).toBe(true)
    expect(
      MemoryGateway.agentToolsDisabled({ providerID: "cloud", endpoint: "https://api.example/v1" }, gateway, "false"),
    ).toBe(false)
  })
  it("derives the status origin only from an enabled local Gateway URL", () => {
    expect(MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "http://localhost:11435/v1/" })).toBe(
      "http://localhost:11435",
    )
    expect(MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "http://127.0.0.1:11435/v1" })).toBe(
      "http://127.0.0.1:11435",
    )
    expect(MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "http://[::1]:11435/v1" })).toBe(
      "http://[::1]:11435",
    )
    expect(MemoryGateway.statusOrigin({ enabled: false, gatewayURL: "http://localhost:11435/v1" })).toBeUndefined()
    expect(MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "https://api.openai.com/v1" })).toBeUndefined()
    expect(MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "http://other-host:11435/v1" })).toBeUndefined()
    expect(
      MemoryGateway.statusOrigin({ enabled: true, gatewayURL: "http://localhost:11435/v1?token=x" }),
    ).toBeUndefined()
  })
  it("is disabled by default and requires an exact local endpoint", () => {
    expect(MemoryGateway.headers(identity, { enabled: false, gatewayURL: gateway.gatewayURL })).toEqual({})
    expect(MemoryGateway.headers(identity, { enabled: true })).toEqual({})
    expect(MemoryGateway.headers({ ...identity, endpoint: "http://127.0.0.1:11434/v1" }, gateway)).toEqual({})
    expect(MemoryGateway.headers({ ...identity, endpoint: "https://api.openai.com/v1" }, gateway)).toEqual({})
    expect(MemoryGateway.headers(identity, { enabled: true, gatewayURL: "https://api.openai.com/v1" })).toEqual({})
    expect(MemoryGateway.headers({ ...identity, projectRoot: "relative/path" }, gateway)).toEqual({})
  })

  it("uses the existing session and project IDs with the absolute project root", () => {
    const first = MemoryGateway.headers(identity, gateway)
    expect(first).toEqual({
      "X-Memory-Session-Id": "ses-one",
      "X-Memory-Project-Id": "project-one",
      "X-Memory-Project-Root": "C:\\Projects\\one",
      "X-Memory-Request-Kind": "user",
    })
    expect(MemoryGateway.headers({ ...identity, requestKind: "user" }, gateway)).toEqual(first)
    expect(MemoryGateway.headers({ ...identity, sessionID: "ses-two" }, gateway)).toMatchObject({
      "X-Memory-Session-Id": "ses-two",
      "X-Memory-Project-Id": "project-one",
      "X-Memory-Project-Root": "C:\\Projects\\one",
    })
    expect(
      MemoryGateway.headers({ ...identity, projectID: "project-two", projectRoot: "C:\\Projects\\two" }, gateway),
    ).toMatchObject({ "X-Memory-Project-Id": "project-two", "X-Memory-Project-Root": "C:\\Projects\\two" })
  })

  it("gives unrelated non-git directories separate stable local identities", () => {
    const first = MemoryGateway.headers({ ...identity, projectID: "global", directory: "C:\\Projects\\one" }, gateway)
    const again = MemoryGateway.headers({ ...identity, projectID: "global", directory: "C:\\Projects\\one" }, gateway)
    const other = MemoryGateway.headers({ ...identity, projectID: "global", directory: "C:\\Projects\\two" }, gateway)
    expect(first["X-Memory-Project-Id"]).toBe(again["X-Memory-Project-Id"])
    expect(first["X-Memory-Project-Id"]).not.toBe(other["X-Memory-Project-Id"])
    expect(first["X-Memory-Project-Root"]).toBe("C:\\Projects\\one")
    expect(MemoryGateway.effectiveProjectID({ ...identity, projectID: "global", directory: "C:\\Projects\\one" })).toBe(
      first["X-Memory-Project-Id"],
    )
    expect(MemoryGateway.effectiveProjectID(identity)).toBe("project-one")
  })

  it("marks known auxiliary calls and keeps existing provider headers", () => {
    const merged = {
      Authorization: "Bearer existing",
      "Content-Type": "application/json",
      ...MemoryGateway.headers({ ...identity, requestKind: "title" }, gateway),
    }
    expect(merged).toMatchObject({
      Authorization: "Bearer existing",
      "Content-Type": "application/json",
      "X-Memory-Request-Kind": "title",
    })
  })
})
