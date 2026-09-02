export interface UserData {
  id: number;
  email: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  countryCode: string;
  avatar: string | null;
}

export interface OwnUserData extends UserData {
}

export const OFFLINE_USER : OwnUserData = {
  id: -1,
  firstName: 'Anonymous',
  lastName: 'User',
  displayName: 'Anonymous User',
  avatar: null,
  countryCode: 'UA',
  email: null,
}
