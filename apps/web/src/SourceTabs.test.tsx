import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SonosSpotifyAccount } from "@misonos/sonos-protocol";
import { SourceTabs } from "./SourcePicker.js";
import { profilesOf } from "./spotifyProfiles.js";

const account = (sn: number, name?: string): SonosSpotifyAccount => ({ sid: 9, sn, token: `t${sn}`, seenOn: [], uses: 0, name });

describe("profilesOf", () => {
  it("offers the named Spotify logins, by name", () => {
    const profiles = profilesOf({ accounts: [account(3, "Pepe"), account(5, "Mia"), account(6)], selected: { sid: 9, sn: 3, token: "t3", origin: "auto" } });
    expect(profiles.map((profile) => [profile.label, profile.title])).toEqual([["Pepe", "Spotify Pepe"], ["Mia", "Spotify Mia"]]);
  });

  it("numbers the logins while none has a name", () => {
    const profiles = profilesOf({ accounts: [account(3), account(5)] });
    expect(profiles.map((profile) => [profile.label, profile.title])).toEqual([["#3", "Spotify login #3"], ["#5", "Spotify login #5"]]);
  });

  it("offers none with a single login, or one pinned by the server", () => {
    expect(profilesOf({ accounts: [account(3, "Pepe")] })).toEqual([]);
    expect(profilesOf({ accounts: [account(3, "Pepe"), account(5, "Mia")], selected: { sid: 9, sn: 5, token: "t5", origin: "env" } })).toEqual([]);
  });
});

describe("SourceTabs", () => {
  const sources = [{ id: "navidrome", name: "Navidrome" }, { id: "spotify", name: "Spotify" }];

  it("names the chosen source and leaves the others as logos", () => {
    const onChange = vi.fn();
    render(<SourceTabs sources={sources} value="navidrome" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Navidrome" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Spotify" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Navidrome")).toBeInTheDocument();
    expect(screen.queryByText("Spotify")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spotify" }));
    expect(onChange).toHaveBeenCalledWith("spotify");
  });

  it("gives each Spotify login a button, which switches to Spotify and picks the login", () => {
    const onChange = vi.fn();
    const pickMia = vi.fn();
    render(
      <SourceTabs
        sources={sources}
        value="navidrome"
        onChange={onChange}
        variants={{
          spotify: [
            { key: "9:3", label: "Pepe", title: "Spotify Pepe", selected: true, onSelect: vi.fn() },
            { key: "9:5", label: "Mia", title: "Spotify Mia", selected: false, onSelect: pickMia }
          ]
        }}
      />
    );
    expect(screen.queryByRole("button", { name: "Spotify" })).not.toBeInTheDocument();
    // Pepe's login is the chosen one, but Spotify isn't the source showing.
    expect(screen.getByRole("button", { name: "Spotify Pepe" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Spotify Mia" }));
    expect(onChange).toHaveBeenCalledWith("spotify");
    expect(pickMia).toHaveBeenCalledTimes(1);
  });
});
