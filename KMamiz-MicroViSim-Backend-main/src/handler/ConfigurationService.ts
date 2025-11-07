import IRequestHandler from "../entities/TRequestHandler";
import GlobalSettings from "../GlobalSettings";

export default class ConfigurationService extends IRequestHandler {
  constructor() {
    super("configuration");
    this.addRoute(
      "get",
      "/config",
      async (_, res) => {
        res.json({ 
          SimulatorMode: GlobalSettings.SimulatorMode
        });
      }
    );
  }


}
