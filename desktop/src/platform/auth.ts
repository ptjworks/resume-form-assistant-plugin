import type { AuthSession, CareerStatusId } from "./types.ts";

export interface AuthService {
  getSession(): Promise<AuthSession>;
  subscribe(listener: (session: AuthSession) => void): () => void;
  loginWithEmailOtp(email: string, code: string): Promise<AuthSession>;
  logout(): Promise<void>;
  updateCareerStatus(status: CareerStatusId): Promise<void>;
}
