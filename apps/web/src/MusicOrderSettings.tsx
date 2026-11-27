import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { bridgeApi } from "./api.js";
import { FOLDER_ORDER_PREF, loadPref, readLocalPref, SEARCH_SECTION_ORDER_PREF, setPref, type PrefDef } from "./prefs.js";
import { inSavedOrder, orderKey, savedOrder, SEARCH_SECTIONS, type OrderEntry } from "./musicOrder.js";
import { SettingsSection } from "./SettingsSection.js";
import { SourceTabs, type SourceVariant } from "./SourcePicker.js";
import { useSpotifyProfiles } from "./spotifyProfiles.js";

interface MusicOrderSettingsProps {
  customIcons: Record<string, string>;
  /** The running, switched-on sources. */
  sources: { id: string; name: string }[];
}

type Orders = Record<string, string[]>;

/** One shared order preference, kept in step with the bridge. */
function useOrders(pref: PrefDef<Orders>) {
  const [orders, setOrders] = useState<Orders>(() => readLocalPref(pref) ?? {});
  useEffect(() => {
    let cancelled = false;
    void loadPref(pref).then((value) => { if (!cancelled && value) setOrders(value); });
    return () => { cancelled = true; };
  }, [pref]);
  const save = (next: Orders) => {
    setOrders(next);
    setPref(pref, next);
  };
  return [orders, save] as const;
}

// Settings → Order in Music: per source, and per Spotify login, the order of Music's
// top-level folders (Playlists, Liked Songs, …) and of a search's sections (Songs,
// Artists, Albums, Playlists).
export function MusicOrderSettings({ customIcons, sources }: MusicOrderSettingsProps) {
  const [folderOrders, saveFolderOrders] = useOrders(FOLDER_ORDER_PREF);
  const [searchOrders, saveSearchOrders] = useOrders(SEARCH_SECTION_ORDER_PREF);

  const spotify = useSpotifyProfiles(sources.some((source) => source.id === "spotify"), true);
  const [pickedSource, setPickedSource] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | undefined>(undefined);

  const source = sources.find((entry) => entry.id === pickedSource) ?? sources[0];
  const profiles = source?.id === "spotify" ? spotify.profiles : [];
  const profile = profiles.find((entry) => entry.key === pickedProfile) ?? profiles.find((entry) => entry.key === spotify.selectedKey) ?? profiles[0];
  const key = source ? orderKey(source.id, profile?.key) : "";

  // The folders Music shows at the top of this source (and login), as Music loads them.
  const [folders, setFolders] = useState<Record<string, OrderEntry[] | "error">>({});
  const sourceId = source?.id;
  const profileKey = profile?.key;
  useEffect(() => {
    if (!sourceId || folders[key]) return undefined;
    let cancelled = false;
    bridgeApi.browseSource(sourceId, undefined, profileKey)
      .then((root) => {
        if (cancelled) return;
        const entries = root.items.filter((item) => item.kind !== "section").map((item) => ({ key: item.id, title: item.title }));
        setFolders((current) => ({ ...current, [key]: entries }));
      })
      .catch(() => { if (!cancelled) setFolders((current) => ({ ...current, [key]: "error" })); });
    return () => { cancelled = true; };
  }, [sourceId, profileKey, key, folders]);

  if (!source) return null;
  const whose = profile ? profile.title : source.name;
  const loaded = folders[key];
  const searchSections = SEARCH_SECTIONS[source.id];

  const spotifyVariants: SourceVariant[] = spotify.profiles.map((entry) => ({
    key: entry.key,
    label: entry.label,
    title: entry.title,
    selected: source.id === "spotify" && entry.key === profile?.key,
    onSelect: () => setPickedProfile(entry.key)
  }));

  return (
    <SettingsSection id="music-order" title="Order in Music">
      <p className="music-order-hint">The order of a source&rsquo;s folders and of its search results in Music. Each Spotify login has its own.</p>
      <SourceTabs
        sources={sources}
        value={source.id}
        onChange={setPickedSource}
        customIcons={customIcons}
        variants={spotifyVariants.length > 0 ? { spotify: spotifyVariants } : undefined}
      />
      <h4 className="music-order-heading">Folders</h4>
      {loaded === undefined ? (
        <p className="music-order-note">Loading {whose}&rsquo;s folders…</p>
      ) : loaded === "error" ? (
        <p className="music-order-note">Couldn&rsquo;t load {whose}&rsquo;s folders.</p>
      ) : loaded.length < 2 ? (
        <p className="music-order-note">{whose} has nothing to order here.</p>
      ) : (
        <OrderList
          label={`${whose} folders`}
          entries={loaded}
          orders={folderOrders}
          sourceId={source.id}
          orderKeyHere={key}
          profileKey={profile?.key}
          onSave={saveFolderOrders}
        />
      )}
      {searchSections ? (
        <>
          <h4 className="music-order-heading">Search results</h4>
          <OrderList
            label={`${whose} search sections`}
            entries={searchSections}
            orders={searchOrders}
            sourceId={source.id}
            orderKeyHere={key}
            profileKey={profile?.key}
            onSave={saveSearchOrders}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

interface OrderListProps {
  label: string;
  entries: OrderEntry[];
  orders: Orders;
  sourceId: string;
  orderKeyHere: string;
  profileKey?: string;
  onSave: (next: Orders) => void;
}

function OrderList({ label, entries, orders, sourceId, orderKeyHere, profileKey, onSave }: OrderListProps) {
  const shown = inSavedOrder(entries, savedOrder(orders, sourceId, profileKey), (entry) => entry.key);
  const move = (index: number, to: number) => {
    const keys = shown.map((entry) => entry.key);
    const [moved] = keys.splice(index, 1);
    keys.splice(to, 0, moved);
    onSave({ ...orders, [orderKeyHere]: keys });
  };
  const reset = () => {
    const next = { ...orders };
    delete next[orderKeyHere];
    onSave(next);
  };
  return (
    <>
      <ol className="music-order-list" aria-label={label}>
        {shown.map((entry, index) => (
          <li key={entry.key} className="music-order-row">
            <span className="music-order-position" aria-hidden="true">{index + 1}</span>
            <span className="music-order-title">{entry.title}</span>
            <span className="queue-reorder">
              <button type="button" title="Move up" aria-label={`Move ${entry.title} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                <ChevronUp size={15} />
              </button>
              <button type="button" title="Move down" aria-label={`Move ${entry.title} down`} disabled={index === shown.length - 1} onClick={() => move(index, index + 1)}>
                <ChevronDown size={15} />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {orders[orderKeyHere] !== undefined ? (
        <button type="button" className="music-order-reset" aria-label={`Reset the order of ${label}`} onClick={reset}>Reset order</button>
      ) : null}
    </>
  );
}
