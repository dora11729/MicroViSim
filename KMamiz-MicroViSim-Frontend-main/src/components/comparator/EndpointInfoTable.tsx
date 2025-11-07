import { useState, useEffect, useRef } from "react";
import { Box, Table, TableBody, TableCell, TableRow } from "@mui/material";
type Props = {
    namespace: string;
    service: string;
    version: string;
    method: string;
    path: string;
};

export default function EndpointInfoTable({
    namespace,
    service,
    version,
    method,
    path,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isNarrow, setIsNarrow] = useState(false);

    useEffect(() => {
        function handleResize() {
            if (!containerRef.current) return;
            setIsNarrow(containerRef.current.offsetWidth < 800);
        }

        handleResize();
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    return (
        <Box ref={containerRef} sx={{ display: "flex", justifyContent: isNarrow ? "flex-start" : "center" }}>
            <Table
                size="small"
                sx={{
                    width: isNarrow ? "100%" : "80%",
                    borderCollapse: "collapse",
                    border: "1px solid #000",
                }}
            >
                <TableBody>
                    {!isNarrow ? (
                        <TableRow>
                            {["Namespace", "Service", "Version", "Method", "Path"].map((header, i) => (
                                <TableCell
                                    key={header}
                                    align="center"
                                    sx={{
                                        fontWeight: "bold",
                                        backgroundColor: "#4db6ac",
                                        borderRight: i !== 4 ? "1px solid #000" : "none",
                                    }}
                                >
                                    {header}
                                </TableCell>
                            ))}
                        </TableRow>
                    ) : (
                        <>
                            {[
                                { label: "Namespace", value: namespace },
                                { label: "Service", value: service },
                                { label: "Version", value: version },
                                { label: "Method", value: method },
                                { label: "Path", value: path },
                            ].map(({ label, value }, i) => (
                                <TableRow key={label}>
                                    <TableCell
                                        align="left"
                                        sx={{
                                            fontWeight: "bold",
                                            backgroundColor: "#4db6ac",
                                            borderRight: "1px solid #000",
                                            width: "30%",
                                        }}
                                    >
                                        {label}
                                    </TableCell>
                                    <TableCell align="left" sx={{ width: "70%" }}>
                                        {value}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </>
                    )}

                    {!isNarrow && (
                        <TableRow>
                            {[namespace, service, version, method, path].map((value, i) => (
                                <TableCell
                                    key={i}
                                    align="center"
                                    sx={{
                                        borderRight: i !== 4 ? "1px solid #000" : "none",
                                    }}
                                >
                                    {value}
                                </TableCell>
                            ))}
                        </TableRow>
                    )}
                </TableBody>


            </Table>
        </Box>
    );
}
