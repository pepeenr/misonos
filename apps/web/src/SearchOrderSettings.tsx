import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { bridgeApi } from "./api.js";
import { loadPref, readLocalPref, SEARCH_SECTION_ORDER_PREF, setPref } from "./prefs.js";
import { orderKey, savedOrder, SEARCH_SECTIONS, sectionsInOrder } from "./searchSections.js";
import { SettingsSection } from "./SettingsSection.js";
import { SourceTabs, type SourceVariant } from "./SourcePicker.js";
import { useSpotifyProfiles } from "./spotifyProfiles.js";

interface SearchOrderSettingsProps {
  customIcons: Record<string, string>;
  /** Bumped when sources are turned on or off. */
  sourcesVersion: number;
}

// Settings → Search results order: per source, and per Spotify login, the order Music
// shows a search's sections in (Songs, Artists, Albums, Playlists).
export function SearchOrderSettings({ customIcons, sourcesVersion }: SearchOrderSettingsProps) {
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    bridgeApi.listSources()
      .then((all) => { if (!cancelled) setSources(all.filter((source) => SEARCH_SECTIONS[source.id])); })
      .catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, [sourcesVersion]);

  const [orders, setOrders] = useState<Record<string, string[]>>(() => readLocalPref(SEARCH_SECTION_ORDER_PREF) ?? {});
  useEffect(() => {
    let cancelled = false;
    void loadPref(SEARCH_SECTION_ORDER_PREF).then((value) => { if (!cancelled && value) setOrders(value); });
    return () => { cancelled = true; };
  }, []);

  const spotify = useSpotifyProfiles(sources.some((source) => source.id === "spotify"), true);
  const [pickedSource, setPickedSource] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | undefined>(undefined);

  if (sources.length === 0) return null;
  const source = sources.find((entry) => entry.id === pickedSource) ?? sources[0];
  const profiles = source.id === "spotify" ? spotify.profiles : [];
  const profile = profiles.find((entry) => entry.key === pickedProfile) ?? profiles.find((entry) => entry.key === spotify.selectedKey) ?? profiles[0];
  const key = orderKey(source.id, profile?.key);
  const sections = sectionsInOrder(SEARCH_SECTIONS[source.id], savedOrder(orders, source.id, profile?.key));
  const own = orders[key] !== undefined;
  const whose = profile ? profile.title : source.name;

  const save = (next: Record<string, string[]>) => {
    setOrders(next);
    setPref(SEARCH_SECTION_ORDER_PREF, next);
  };
  const move = (index: number, to: number) => {
    const keys = sections.map((section) => section.key);
    const [moved] = keys.splice(index, 1);
    keys.splice(to, 0, moved);
    save({ ...orders, [key]: keys });
  };
  const reset = () => {
    const next = { ...orders };
    delete next[key];
    save(next);
  };

  const spotifyVariants: SourceVariant[] = spotify.profiles.map((entry) => ({
    key: entry.key,
    label: entry.label,
    title: entry.title,
    selected: source.id === "spotify" && entry.key === profile?.key,
    onSelect: () => setPickedProfile(entry.key)
  }));

  return (
    <SettingsSection id="search-order" title="Search results order">
      <p className="search-order-hint">The order Music shows a search&rsquo;s sections in. Each Spotify login has its own.</p>
      <SourceTabs
        sources={sources}
        value={source.id}
        onChange={setPickedSource}
        customIcons={customIcons}
        variants={spotifyVariants.length > 0 ? { spotify: spotifyVariants } : undefined}
      />
      <ol className="search-order-list" aria-label={`${whose} search sections`}>
        {sections.map((section, index) => (
          <li key={section.key} className="search-order-row">
            <span className="search-order-position" aria-hidden="true">{index + 1}</span>
            <span className="search-order-title">{section.title}</span>
            <span className="queue-reorder">
              <button type="button" title="Move up" aria-label={`Move ${section.title} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                <ChevronUp size={15} />
              </button>
              <button type="button" title="Move down" aria-label={`Move ${section.title} down`} disabled={index === sections.length - 1} onClick={() => move(index, index + 1)}>
                <ChevronDown size={15} />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {own ? (
        <button type="button" className="search-order-reset" onClick={reset}>Reset order</button>
      ) : null}
    </SettingsSection>
  );
}
