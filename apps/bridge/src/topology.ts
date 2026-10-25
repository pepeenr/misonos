import type { SonosGroup, SonosZone } from "@misonos/sonos-protocol";
import { allTagBlocks, attrText, openingTags, selfClosingTags, tagText } from "@misonos/sonos-protocol";

function parseGen(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function zoneFromDeviceDescription(ipAddress: string, location: string, xml: string): SonosZone {
  const uuid = (tagText(xml, "UDN") ?? `uuid:${ipAddress}`).replace(/^uuid:/, "");
  return {
    id: uuid,
    uuid,
    name: tagText(xml, "roomName") ?? tagText(xml, "friendlyName") ?? ipAddress,
    ipAddress,
    location,
    visible: true,
    swGen: parseGen(tagText(xml, "swGen"))
  };
}

export function parseZoneGroupState(xml: string): { zones: SonosZone[]; groups: SonosGroup[] } {
  const zones = new Map<string, SonosZone>();
  const groups: SonosGroup[] = [];

  for (const groupBlock of allTagBlocks(xml, "ZoneGroup")) {
    const coordinatorId = attrText(groupBlock, "Coordinator") ?? "";
    const groupId = attrText(groupBlock, "ID") ?? coordinatorId;
    const groupZones: SonosZone[] = [];

    // A bonded coordinator (home theater, stereo pair) is a container wrapping its
    // <Satellite/> children, so members can't be assumed self-closing. Satellites carry
    // the same UUID/Location/ZoneName attributes and declare Invisible="1", so they fall
    // out of the same extraction as hidden zones.
    const memberTags = [
      ...openingTags(groupBlock, "ZoneGroupMember"),
      ...selfClosingTags(groupBlock, "Satellite")
    ];

    for (const memberTag of memberTags) {
      const uuid = attrText(memberTag, "UUID") ?? attrText(memberTag, "Uuid") ?? "";
      if (!uuid) continue;
      const location = attrText(memberTag, "Location") ?? "";
      const ipAddress = location.match(/^https?:\/\/([^/:]+)/i)?.[1] ?? "";
      const zone: SonosZone = {
        id: uuid,
        uuid,
        name: attrText(memberTag, "ZoneName") ?? ipAddress ?? uuid,
        ipAddress,
        location,
        coordinatorId,
        groupId,
        visible: attrText(memberTag, "Invisible") !== "1",
        swGen: parseGen(attrText(memberTag, "SWGen"))
      };
      zones.set(uuid, zone);
      groupZones.push(zone);
    }

    // File each hidden member under its room: the visible member it's nested in as a
    // <Satellite/>, or the visible member that shares its channel map (a stereo pair
    // and its Sub list each other in ChannelMapSet, a home theater in HTSatChanMapSet).
    const parents = satelliteParents(groupBlock);
    const channelMaps = new Map(memberTags.map((tag) => [attrText(tag, "UUID") ?? attrText(tag, "Uuid") ?? "", channelMapMembers(tag)]));
    for (const zone of groupZones) {
      if (zone.visible) continue;
      const room = groupZones.find((candidate) => candidate.visible && (
        parents.get(zone.uuid) === candidate.uuid ||
        channelMaps.get(candidate.uuid)?.includes(zone.uuid) ||
        channelMaps.get(zone.uuid)?.includes(candidate.uuid)
      ));
      if (room) zone.bondedTo = room.uuid;
    }

    const coordinator = groupZones.find((zone) => zone.uuid === coordinatorId) ?? groupZones[0];
    if (coordinator) {
      groups.push({
        id: groupId,
        coordinatorId: coordinator.uuid,
        coordinatorName: coordinator.name,
        zones: groupZones
      });
    }
  }

  return { zones: [...zones.values()], groups };
}

// Satellite uuid → the uuid of the ZoneGroupMember container it's nested in. Walks the
// tags in order, since a member is self-closing unless it holds satellites.
function satelliteParents(groupBlock: string): Map<string, string> {
  const parents = new Map<string, string>();
  let container: string | undefined;
  for (const [, closing, tagName, attributes, selfClosing] of groupBlock.matchAll(/<(\/?)(ZoneGroupMember|Satellite)\b([^>]*?)(\/?)>/gi)) {
    if (closing) {
      container = undefined;
    } else if (tagName.toLowerCase() === "satellite") {
      const uuid = attrText(attributes, "UUID");
      if (uuid && container) parents.set(uuid, container);
    } else if (!selfClosing) {
      container = attrText(attributes, "UUID");
    }
  }
  return parents;
}

// The uuids in a member's channel map, e.g. "RINCON_L:LF,LF;RINCON_R:RF,RF;RINCON_SUB:SW".
function channelMapMembers(memberTag: string): string[] {
  const maps = [attrText(memberTag, "ChannelMapSet"), attrText(memberTag, "HTSatChanMapSet")].filter(Boolean).join(";");
  return maps.split(";").map((entry) => entry.split(":")[0]).filter(Boolean);
}
