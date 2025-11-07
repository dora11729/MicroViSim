const requestTypeLower = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "connect",
  "trace",
] as const;

const requestTypeUpper = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE"
] as const;

export const requestType = [
  ...requestTypeLower, ...requestTypeUpper
] as const

export type TRequestTypeLower = typeof requestTypeLower[number];

export type TRequestTypeUpper = typeof requestTypeUpper[number];

export type TRequestType = typeof requestType[number];