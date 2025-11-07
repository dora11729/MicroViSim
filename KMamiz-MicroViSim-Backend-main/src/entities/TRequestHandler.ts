import { Request, Response, RequestHandler  } from "express";
import { TRequestTypeLower } from "./TRequestType";

export default abstract class IRequestHandler {
  private readonly identifier: string;
  protected readonly routes: {
    method: TRequestTypeLower;
    path: string;
    handler: (req: Request, res: Response) => void;
    middleware: RequestHandler[];
  }[] = [];

  constructor(identifier: string = "") {
    this.identifier = identifier;
  }

  protected addRoute(
    method: TRequestTypeLower,
    path: string,
    handler: (req: Request, res: Response) => void,
    middleware: RequestHandler[] = [] 
  ) {
    this.routes.push({ 
      method, 
      path: `/${this.identifier}${path}`, 
      handler,
      middleware,
    });
  }

  getRoutes() {
    return this.routes;
  }
}
