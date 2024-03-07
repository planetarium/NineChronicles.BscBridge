import { ChatPostMessageArguments } from "@slack/web-api";
import { ForceOmit } from "../types/force-omit";

export interface Message {
    render(): ForceOmit<ChatPostMessageArguments, "channel">;
}
