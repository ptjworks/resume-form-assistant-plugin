import type { CommunityChannel, CommunityComment, CommunityPost, HotTopicItem } from "./types.ts";

export interface DesensitizedDraftPreview {
  originalNoteId: string;
  maskedTitle: string;
  maskedBody: string;
  redactedItems: Array<{ kind: "phone" | "email" | "name" | "id"; sample: string }>;
}

export interface CommunityService {
  listFeed(query: {
    channel: CommunityChannel;
    search?: string;
    company?: string;
    cursor?: string;
  }): Promise<{ items: CommunityPost[]; nextCursor?: string | null }>;
  createPost(input: {
    content: string;
    visibility: "public" | "private_local";
    kind?: CommunityPost["kind"];
    companyName?: string;
    imageFiles?: File[];
    pollOptions?: [string, string];
  }): Promise<CommunityPost>;
  castPollVote(pollId: string, optionId: string): Promise<CommunityPost["poll"]>;
  toggleReaction(postId: string, kind: "like" | "bless" | "empathy" | "save"): Promise<CommunityPost["stats"]>;
  listComments(postId: string): Promise<CommunityComment[]>;
  createComment(postId: string, content: string): Promise<CommunityComment>;
  getHotTopics(): Promise<{ onlineCount: number; topics: HotTopicItem[] }>;
  getDailyTeaPoll(): Promise<CommunityPost["poll"]>;
  /** 将本地 #490 心得先脱敏预览，经用户确认后再发布到广场 */
  previewDesensitizedNote(noteId: string): Promise<DesensitizedDraftPreview>;
  publishDesensitizedNote(preview: DesensitizedDraftPreview): Promise<CommunityPost>;
}
