import 'twin.macro';
import React, { HTMLAttributes, PropsWithChildren } from 'react';
declare const Collapse: React.FC<PropsWithChildren<{
    className?: HTMLAttributes<HTMLDivElement>['className'];
    height: string | number;
    maxHeight: string | number;
    expanded: boolean;
}>>;
export default Collapse;
