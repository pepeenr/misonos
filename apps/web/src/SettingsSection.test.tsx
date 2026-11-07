import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsCard, SettingsSection } from "./SettingsSection.js";

describe("Settings sections", () => {
  beforeEach(() => window.localStorage.clear());

  it("folds a section away, keeps what's inside it, and remembers the fold", () => {
    const onRefresh = vi.fn();
    const view = (
      <SettingsSection id="equalizer" title="Equalizer" actions={<button type="button" onClick={onRefresh}>Refresh</button>}>
        <input aria-label="Preset name" />
      </SettingsSection>
    );
    const { unmount } = render(view);
    const toggle = screen.getByRole("button", { name: "Equalizer" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Warm" } });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Preset name")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Preset name")).toBeVisible();
    expect(screen.getByLabelText("Preset name")).toHaveValue("Warm"); // the fold doesn't reset it

    // The title row's own buttons don't fold it.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Anywhere else on the row does, and the next visit finds it folded.
    fireEvent.click(toggle.closest(".section-heading")!);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    unmount();
    render(view);
    expect(screen.getByRole("button", { name: "Equalizer" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps each section's fold apart, for cards too", () => {
    render(
      <>
        <SettingsSection id="alarms" title="Alarms"><p>Wake up</p></SettingsSection>
        <SettingsCard id="spotify" title="Spotify"><p>Sign in</p></SettingsCard>
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Spotify" }));
    expect(screen.getByText("Sign in")).not.toBeVisible();
    expect(screen.getByText("Wake up")).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem("misonos:settingsCollapsed") ?? "{}")).toEqual({ spotify: true });

    fireEvent.click(screen.getByRole("button", { name: "Alarms" }));
    expect(JSON.parse(window.localStorage.getItem("misonos:settingsCollapsed") ?? "{}")).toEqual({ spotify: true, alarms: true });
    fireEvent.click(screen.getByRole("button", { name: "Spotify" }));
    expect(screen.getByText("Sign in")).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem("misonos:settingsCollapsed") ?? "{}")).toEqual({ alarms: true });
  });
});
