import { createTwoFilesPatch } from "diff";
import {
  Diff2HtmlUI,
  Diff2HtmlUIConfig,
} from "diff2html/lib/ui/js/diff2html-ui";
import { useEffect, useMemo, useRef } from "react";

export type InterfaceDiffDisplayProps = {
  name: string;
  oldStr: string;
  newStr: string;
};
export default function InterfaceDiffDisplay(props: InterfaceDiffDisplayProps) {
  const divRef = useRef<any>();
  const diff = useMemo(
    () =>
      createTwoFilesPatch(
        `${props.name}.ts`,
        `${props.name}.ts`,
        props.oldStr,
        props.newStr
      ),
    [props]
  );
  const config = useMemo<Diff2HtmlUIConfig>(
    () => ({
      drawFileList: false,
      matching: "lines",
      outputFormat: "side-by-side",
      fileListToggle: false,
      fileListStartVisible: false,
      fileContentToggle: false,
      highlight: true,
    }),
    []
  );

  useEffect(() => {
    if (divRef.current) {
      const diff2htmlUi = new Diff2HtmlUI(divRef.current, diff, config);
      diff2htmlUi.draw();
      diff2htmlUi.highlightCode();
    }
  }, [divRef.current, diff]);

  return <div ref={divRef}></div>;
}
