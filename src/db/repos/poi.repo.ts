import { getDb } from '../client.js';
import { normalizeCategory, type PoiCategory } from '../../util/poi.js';

export interface Poi {
  id: number;
  chatId: number;
  tgUserId: number | null;
  name: string;
  category: PoiCategory;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: number;
}

interface PoiRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  name: string;
  category: string;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: number;
}

function toPoi(r: PoiRow): Poi {
  return {
    id: r.id,
    chatId: r.chat_id,
    tgUserId: r.tg_user_id,
    name: r.name,
    category: normalizeCategory(r.category),
    description: r.description,
    address: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
    createdAt: r.created_at,
  };
}

export function addPoi(args: {
  chatId: number;
  tgUserId: number | null;
  name: string;
  category: PoiCategory;
  description?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): Poi {
  const info = getDb()
    .prepare(
      `INSERT INTO point_of_interest
         (chat_id, tg_user_id, name, category, description, address, latitude, longitude, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.tgUserId,
      args.name,
      args.category,
      args.description ?? null,
      args.address ?? null,
      args.latitude ?? null,
      args.longitude ?? null,
    );
  return getPoi(Number(info.lastInsertRowid))!;
}

export function getPoi(id: number): Poi | undefined {
  const row = getDb()
    .prepare('SELECT * FROM point_of_interest WHERE id = ?')
    .get(id) as PoiRow | undefined;
  return row ? toPoi(row) : undefined;
}

export function listPois(chatId: number): Poi[] {
  const rows = getDb()
    .prepare('SELECT * FROM point_of_interest WHERE chat_id = ? ORDER BY created_at ASC, id ASC')
    .all(chatId) as PoiRow[];
  return rows.map(toPoi);
}

export function deletePoi(id: number, chatId: number): boolean {
  const info = getDb()
    .prepare('DELETE FROM point_of_interest WHERE id = ? AND chat_id = ?')
    .run(id, chatId);
  return info.changes > 0;
}
