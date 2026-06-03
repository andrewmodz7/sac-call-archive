// Shapes locked against a real CloudTalk response (probe run, task 1).
// Envelope: { responseData: { itemsCount, pageCount, pageNumber, limit, data: [...] } }
// Each item in `data` is a call wrapped in Cdr / Agent / Contact / Tags sub-objects.

export interface CdrFields {
  id: number | string;
  recorded: boolean;
  is_voicemail: boolean;
  recording_link: string; // https://my.cloudtalk.io/r/play/{call_id}
  started_at: string; // ISO 8601 with offset, CloudTalk server is +02:00
  public_external: string; // prospect phone, E.164
}

export interface AgentFields {
  firstname: string;
}

export interface ContactFields {
  // single full-name string, e.g. "Andrew Test". May be null/empty.
  name: string | null;
  // US state code, e.g. "NV", "GA", "AL". Probe data shows it's always present
  // as a string or null.
  state: string | null;
}

export interface Tag {
  id: number;
  name: string;
}

// One call object. Agent / Contact can be absent on odd records, so keep them
// nullable and guard at the edges rather than trusting they're always there.
export interface CloudtalkCall {
  Cdr: CdrFields;
  Agent: AgentFields | null;
  Contact: ContactFields | null;
  // Tags[].name is the disposition string and matches the UI label exactly.
  // Do not read Contact.tags[] here, those are list-segmentation tags.
  Tags: Tag[];
}

export interface ResponseData {
  itemsCount: number;
  pageCount: number;
  pageNumber: number;
  limit: number;
  data: CloudtalkCall[];
}

export interface CloudtalkListResponse {
  responseData: ResponseData;
}

// Terminal action recorded for every call we see.
export type ProcessedAction =
  | "archived"
  | "skipped_no_recording"
  | "skipped_voicemail_flag"
  | "skipped_disposition"
  | "skipped_no_disposition"
  | "skipped_expired" // recording returned 410 Gone (purged after retention)
  | "failed";
