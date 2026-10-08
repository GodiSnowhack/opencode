import { expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict as english } from "../i18n/en"
import { dict as russian } from "../i18n/ru"
import { USAGE_ENGLISH, USAGE_RUSSIAN } from "../i18n/usage-fallback"

test("Usage Russian locale overrides every fallback key and preserves placeholders", () => {
  expect(Object.keys(USAGE_RUSSIAN).sort()).toEqual(Object.keys(USAGE_ENGLISH).sort())
  const source: Record<string, string> = english
  const target: Record<string, string> = russian
  const translated: Record<string, string> = USAGE_RUSSIAN
  for (const [key, value] of Object.entries(USAGE_ENGLISH)) {
    expect(source[key]).toBe(value)
    expect(target[key]).toBe(translated[key])
    expect(target[key].trim()).not.toBe("")
    expect(target[key]).not.toBe(source[key])
    expect(target[key].match(/\{\{\w+\}\}/gu) ?? []).toEqual(value.match(/\{\{\w+\}\}/gu) ?? [])
  }
})

test("Profile Overview, Models and clear dialog resolve complete Russian phrases", () => {
  expect(russian["usage.title"]).toBe("Статистика использования")
  expect(russian["usage.overview"]).toBe("Обзор")
  expect(russian["usage.models"]).toBe("Модели")
  expect(russian["usage.empty"]).toBe("Пока нет зарегистрированных запросов к моделям.")
  expect(resolveTemplate(russian["usage.since"], { date: "8 октября 2026" })).toBe(
    "Статистика собирается с 8 октября 2026.",
  )
  expect(resolveTemplate(russian["usage.unknown"], { count: 2 })).toContain("данными о токенах: 2.")
  expect(russian["usage.agent"]).toBe("Модели агента")
  expect(russian["usage.memory"]).toBe("Фоновая обработка памяти")
  expect(russian["usage.service"]).toBe("Служебные и фоновые запросы")
  expect(russian["usage.clear"]).toBe("Очистить статистику")
  expect(russian["usage.clearConfirm"]).toContain("Память, сессии, проекты, модели и настройки будут сохранены.")
  expect(russian["memory.manager.confirm"]).toBe("Подтвердить")
  expect(russian["common.cancel"]).toBe("Отмена")
})

test("all Profile component copy keys use translated locale entries", async () => {
  const source = await Bun.file(new URL("../components/settings-v2/usage.tsx", import.meta.url)).text()
  const keys = [...source.matchAll(/"(usage\.[A-Za-z0-9]+)"/gu)].map((match) => match[1])
  expect(keys.length).toBeGreaterThan(30)
  for (const key of keys) {
    expect(Object.hasOwn(USAGE_RUSSIAN, key)).toBe(true)
  }
  expect(source).not.toContain("Статистика использования")
})
