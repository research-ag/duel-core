import Text "mo:core/Text";
import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Nat64 "mo:core/Nat64";
import Time "mo:core/Time";

module {
  public func custom_print(s : Text) {
    Debug.print(Text.concat("[IC-WEBSOCKET-CDK]: ", s));
  };

  public func custom_trap(s : Text) {
    Runtime.trap(s);
  };

  public func get_current_time() : Nat64 {
    Nat64.fromIntWrap(Time.now());
  };
};
